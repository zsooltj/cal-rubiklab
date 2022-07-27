import { Credential } from "@prisma/client";
import { z } from "zod";

import dayjs from "@calcom/dayjs";
import { handleErrorsJson } from "@calcom/lib/errors";
import prisma from "@calcom/prisma";
import { Frequency } from "@calcom/prisma/zod-utils";
import type { CalendarEvent } from "@calcom/types/Calendar";
import type { PartialReference } from "@calcom/types/EventManager";
import type { VideoApiAdapter, VideoCallData } from "@calcom/types/VideoApiAdapter";

import { getZoomAppKeys } from "./getZoomAppKeys";

/** @link https://marketplace.zoom.us/docs/api-reference/zoom-api/meetings/meetingcreate */
const zoomEventResultSchema = z.object({
  id: z.number(),
  join_url: z.string(),
  password: z.string().optional().default(""),
});

export type ZoomEventResult = z.infer<typeof zoomEventResultSchema>;

export const zoomMeetingsSchema = z.object({
  next_page_token: z.string(),
  page_count: z.number(),
  page_number: z.number(),
  page_size: z.number(),
  total_records: z.number(),
  meetings: z.array(
    z.object({
      agenda: z.string(),
      created_at: z.string(),
      duration: z.number(),
      host_id: z.string(),
      id: z.number(),
      join_url: z.string(),
      pmi: z.string(),
      start_time: z.string(),
      timezone: z.string(),
      topic: z.string(),
      type: z.number(),
      uuid: z.string(),
    })
  ),
});

const zoomTokenSchema = z.object({
  scope: z.string().regex(new RegExp("meeting:write")),
  expiry_date: z.number(),
  expires_in: z.number().optional(), // deprecated, purely for backwards compatibility; superseeded by expiry_date.
  token_type: z.literal("bearer"),
  access_token: z.string(),
  refresh_token: z.string(),
});

type ZoomToken = z.infer<typeof zoomTokenSchema>;

const zoomAuth = (credential: Credential) => {
  const credentialKey = zoomTokenSchema.parse(credential.key);

  const isTokenValid = (token: ZoomToken) =>
    token && token.token_type && token.access_token && (token.expires_in || token.expiry_date) < Date.now();

  const refreshAccessToken = async (refreshToken: string) => {
    const { client_id, client_secret } = await getZoomAppKeys();
    const authHeader = "Basic " + Buffer.from(client_id + ":" + client_secret).toString("base64");
    return fetch("https://zoom.us/oauth/token", {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    })
      .then(handleErrorsJson)
      .then(async (responseBody) => {
        // set expiry date as offset from current time.
        responseBody.expiry_date = Math.round(Date.now() + responseBody.expires_in * 1000);
        delete responseBody.expires_in;
        // Store new tokens in database.
        await prisma.credential.update({
          where: {
            id: credential.id,
          },
          data: {
            key: responseBody,
          },
        });
        credentialKey.expiry_date = responseBody.expiry_date;
        credentialKey.access_token = responseBody.access_token;
        return credentialKey.access_token;
      });
  };

  return {
    getToken: () =>
      !isTokenValid(credentialKey)
        ? Promise.resolve(credentialKey.access_token)
        : refreshAccessToken(credentialKey.refresh_token),
  };
};

type ZoomRecurrence = {
  end_date_time?: string;
  type: 1 | 2 | 3;
  end_times?: number;
  repeat_interval?: number;
  weekly_days?: number; // 1-7 Sunday = 1, Saturday = 7
  monthly_day?: number; // 1-31
};

const ZoomVideoApiAdapter = (credential: Credential): VideoApiAdapter => {
  const translateEvent = (event: CalendarEvent) => {
    const getRecurrence = ({
      recurringEvent,
      startTime,
      attendees,
    }: CalendarEvent): { recurrence: ZoomRecurrence; type: 8 } | undefined => {
      if (!recurringEvent) {
        return;
      }

      let recurrence: ZoomRecurrence;

      switch (recurringEvent.freq) {
        case Frequency.DAILY:
          recurrence = {
            type: 1,
          };
          break;
        case Frequency.WEEKLY:
          recurrence = {
            type: 2,
            weekly_days: dayjs(startTime).tz(attendees[0].timeZone).day() + 1,
          };
          break;
        case Frequency.MONTHLY:
          recurrence = {
            type: 3,
            monthly_day: dayjs(startTime).tz(attendees[0].timeZone).date(),
          };
          break;
        default:
          // Zoom does not support YEARLY, HOURLY or MINUTELY frequencies, don't do anything in those cases.
          return;
      }

      recurrence.repeat_interval = recurringEvent.interval;

      if (recurringEvent.until) {
        recurrence.end_date_time = recurringEvent.until.toISOString();
      } else {
        recurrence.end_times = recurringEvent.count;
      }

      return {
        recurrence: {
          ...recurrence,
        },
        type: 8,
      };
    };

    const recurrence = getRecurrence(event);

    // Documentation at: https://marketplace.zoom.us/docs/api-reference/zoom-api/meetings/meetingcreate
    return {
      topic: event.title,
      type: 2, // Means that this is a scheduled meeting
      start_time: event.startTime,
      duration: (new Date(event.endTime).getTime() - new Date(event.startTime).getTime()) / 60000,
      //schedule_for: "string",   TODO: Used when scheduling the meeting for someone else (needed?)
      timezone: event.attendees[0].timeZone,
      //password: "string",       TODO: Should we use a password? Maybe generate a random one?
      agenda: event.description,
      settings: {
        host_video: true,
        participant_video: true,
        cn_meeting: false, // TODO: true if host meeting in China
        in_meeting: false, // TODO: true if host meeting in India
        join_before_host: true,
        mute_upon_entry: false,
        watermark: false,
        use_pmi: false,
        approval_type: 2,
        audio: "both",
        auto_recording: "none",
        enforce_login: false,
        registrants_email_notification: true,
      },
      ...recurrence,
    };
  };

  const fetchZoomApi = async (endpoint: string, options?: RequestInit) => {
    const auth = zoomAuth(credential);
    const accessToken = await auth.getToken();
    const responseBody = await fetch(`https://api.zoom.us/v2/${endpoint}`, {
      method: "GET",
      ...options,
      headers: {
        Authorization: "Bearer " + accessToken,
        ...options?.headers,
      },
    }).then(handleErrorsJson);

    return responseBody;
  };

  return {
    getAvailability: async () => {
      try {
        // TODO Possibly implement pagination for cases when there are more than 300 meetings already scheduled.
        const responseBody = await fetchZoomApi("users/me/meetings?type=scheduled&page_size=300");
        const data = zoomMeetingsSchema.parse(responseBody);
        return data.meetings.map((meeting) => ({
          start: meeting.start_time,
          end: new Date(new Date(meeting.start_time).getTime() + meeting.duration * 60000).toISOString(),
        }));
      } catch (err) {
        console.error(err);
        /* Prevents booking failure when Zoom Token is expired */
        return [];
      }
    },
    createMeeting: async (event: CalendarEvent): Promise<VideoCallData> => {
      const response: ZoomEventResult = await fetchZoomApi("users/me/meetings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(translateEvent(event)),
      });

      const result = zoomEventResultSchema.parse(response);
      if (result.id && result.join_url) {
        return Promise.resolve({
          type: "zoom_video",
          id: result.id.toString(),
          password: result.password || "",
          url: result.join_url,
        });
      }
      return Promise.reject(new Error("Failed to create meeting"));
    },
    deleteMeeting: async (uid: string): Promise<void> => {
      await fetchZoomApi(`meetings/${uid}`, {
        method: "DELETE",
      });

      return Promise.resolve();
    },
    updateMeeting: async (bookingRef: PartialReference, event: CalendarEvent): Promise<VideoCallData> => {
      await fetchZoomApi(`meetings/${bookingRef.uid}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(translateEvent(event)),
      });

      return Promise.resolve({
        type: "zoom_video",
        id: bookingRef.meetingId as string,
        password: bookingRef.meetingPassword as string,
        url: bookingRef.meetingUrl as string,
      });
    },
  };
};

export default ZoomVideoApiAdapter;
