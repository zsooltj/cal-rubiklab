import {
  Prisma,
  PrismaPromise,
  WorkflowTemplates,
  WorkflowActions,
  WorkflowTriggerEvents,
  BookingStatus,
  WorkflowMethods,
} from "@prisma/client";
import { z } from "zod";

import {
  WORKFLOW_TEMPLATES,
  WORKFLOW_TRIGGER_EVENTS,
  WORKFLOW_ACTIONS,
  TIME_UNIT,
} from "@ee/lib/workflows/constants";
import {
  deleteScheduledEmailReminder,
  scheduleEmailReminder,
} from "@ee/lib/workflows/reminders/emailReminderManager";
import {
  deleteScheduledSMSReminder,
  scheduleSMSReminder,
} from "@ee/lib/workflows/reminders/smsReminderManager";

import { TRPCError } from "@trpc/server";

import { createProtectedRouter } from "../../createRouter";

export const workflowsRouter = createProtectedRouter()
  .query("list", {
    async resolve({ ctx }) {
      const workflows = await ctx.prisma.workflow.findMany({
        where: {
          userId: ctx.user.id,
        },
        include: {
          activeOn: {
            include: {
              eventType: true,
            },
          },
        },
        orderBy: {
          id: "asc",
        },
      });
      return { workflows };
    },
  })
  .query("get", {
    input: z.object({
      id: z.number(),
    }),
    async resolve({ ctx, input }) {
      const workflow = await ctx.prisma.workflow.findFirst({
        where: {
          AND: [
            {
              userId: ctx.user.id,
            },
            {
              id: input.id,
            },
          ],
        },
        select: {
          id: true,
          name: true,
          time: true,
          timeUnit: true,
          activeOn: {
            select: {
              eventType: true,
            },
          },
          trigger: true,
          steps: {
            orderBy: {
              stepNumber: "asc",
            },
          },
        },
      });
      if (!workflow) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
        });
      }
      return workflow;
    },
  })
  .mutation("create", {
    input: z.object({
      name: z.string(),
      trigger: z.enum(WORKFLOW_TRIGGER_EVENTS),
      action: z.enum(WORKFLOW_ACTIONS),
      timeUnit: z.enum(TIME_UNIT).optional(),
      time: z.number().optional(),
      sendTo: z.string().optional(),
    }),
    async resolve({ ctx, input }) {
      const { name, trigger, action, timeUnit, time, sendTo } = input;
      const userId = ctx.user.id;

      try {
        const workflow = await ctx.prisma.workflow.create({
          data: {
            name,
            trigger,
            userId,
            timeUnit: time ? timeUnit : undefined,
            time,
          },
        });

        await ctx.prisma.workflowStep.create({
          data: {
            stepNumber: 1,
            action,
            workflowId: workflow.id,
            sendTo,
          },
        });
        return { workflow };
      } catch (e) {
        throw e;
      }
    },
  })
  .mutation("delete", {
    input: z.object({
      id: z.number(),
    }),
    async resolve({ ctx, input }) {
      const { id } = input;

      //delete all scheduled reminders of this workflow
      const scheduledReminders = await ctx.prisma.workflowReminder.findMany({
        where: {
          workflowStep: {
            workflowId: id,
          },
          scheduled: true,
          NOT: {
            referenceId: null,
          },
        },
      });

      scheduledReminders.forEach((reminder) => {
        if (reminder.referenceId) {
          if (reminder.method === WorkflowMethods.EMAIL) {
            deleteScheduledEmailReminder(reminder.referenceId);
          } else if (reminder.method === WorkflowMethods.SMS) {
            deleteScheduledSMSReminder(reminder.referenceId);
          }
        }
      });

      await ctx.prisma.workflow.deleteMany({
        where: {
          AND: [
            {
              userId: ctx.user.id,
            },
            {
              id,
            },
          ],
        },
      });

      return {
        id,
      };
    },
  })
  .mutation("update", {
    input: z.object({
      id: z.number(),
      name: z.string(),
      activeOn: z.number().array(),
      steps: z
        .object({
          id: z.number(),
          stepNumber: z.number(),
          action: z.enum(WORKFLOW_ACTIONS),
          workflowId: z.number(),
          sendTo: z.string().optional().nullable(),
          reminderBody: z.string().optional().nullable(),
          emailSubject: z.string().optional().nullable(),
          template: z.enum(WORKFLOW_TEMPLATES),
        })
        .array(),
      trigger: z.enum(WORKFLOW_TRIGGER_EVENTS),
      time: z.number().nullable(),
      timeUnit: z.enum(TIME_UNIT).nullable(),
    }),
    async resolve({ input, ctx }) {
      const { user } = ctx;
      const { id, name, activeOn, steps, trigger, time, timeUnit } = input;

      const userWorkflow = await ctx.prisma.workflow.findUnique({
        where: {
          id,
        },
        select: {
          userId: true,
          steps: true,
        },
      });

      if (!userWorkflow || userWorkflow.userId !== user.id) throw new TRPCError({ code: "UNAUTHORIZED" });

      //remove all scheduled Email and SMS reminders for eventTypes that are not active any more
      const oldActiveOnEventTypes = await ctx.prisma.workflowsOnEventTypes.findMany({
        where: {
          workflowId: id,
        },
        select: {
          eventTypeId: true,
        },
      });

      const removedEventTypes = oldActiveOnEventTypes
        .map((eventType) => {
          return eventType.eventTypeId;
        })
        .filter((eventType) => {
          if (!activeOn.includes(eventType)) {
            return eventType;
          }
        });

      const remindersToDeletePromise: PrismaPromise<
        {
          id: number;
          referenceId: string | null;
          method: string;
          scheduled: boolean;
        }[]
      >[] = [];
      removedEventTypes.forEach((eventTypeId) => {
        const reminderToDelete = ctx.prisma.workflowReminder.findMany({
          where: {
            booking: {
              eventTypeId: eventTypeId,
              userId: ctx.user.id,
            },
            workflowStepId: {
              in: userWorkflow.steps.map((step) => {
                return step.id;
              }),
            },
          },
          select: {
            id: true,
            referenceId: true,
            method: true,
            scheduled: true,
          },
        });
        remindersToDeletePromise.push(reminderToDelete);
      });

      const remindersToDelete = await Promise.all(remindersToDeletePromise);

      const deleteReminderPromise: PrismaPromise<Prisma.BatchPayload>[] = [];
      remindersToDelete.flat().forEach((reminder) => {
        //already scheduled reminders
        if (reminder.referenceId) {
          if (reminder.method === WorkflowMethods.EMAIL) {
            deleteScheduledEmailReminder(reminder.referenceId);
          } else if (reminder.method === WorkflowMethods.SMS) {
            deleteScheduledSMSReminder(reminder.referenceId);
          }
        }
        const deleteReminder = ctx.prisma.workflowReminder.deleteMany({
          where: {
            id: reminder.id,
            booking: {
              userId: ctx.user.id,
            },
          },
        });
        deleteReminderPromise.push(deleteReminder);
      });

      await Promise.all(deleteReminderPromise);

      //update active on & reminders for new eventTypes
      await ctx.prisma.workflowsOnEventTypes.deleteMany({
        where: {
          workflowId: id,
        },
      });

      let newEventTypes: number[] = [];
      if (activeOn.length) {
        if (trigger === WorkflowTriggerEvents.BEFORE_EVENT) {
          newEventTypes = activeOn.filter((eventType) => {
            if (
              !oldActiveOnEventTypes ||
              !oldActiveOnEventTypes
                .map((oldEventType) => {
                  return oldEventType.eventTypeId;
                })
                .includes(eventType)
            ) {
              return eventType;
            }
          });
        }
        if (newEventTypes.length > 0) {
          //create reminders for all bookings with newEventTypes
          const bookingsForReminders = await ctx.prisma.booking.findMany({
            where: {
              eventTypeId: { in: newEventTypes },
              status: BookingStatus.ACCEPTED,
              startTime: {
                gte: new Date(),
              },
            },
            include: {
              attendees: true,
              eventType: true,
              user: true,
            },
          });

          steps.forEach(async (step) => {
            if (step.action !== WorkflowActions.SMS_ATTENDEE) {
              //as we do not have attendees phone number (user is notified about that when setting this action)
              bookingsForReminders.forEach(async (booking) => {
                const bookingInfo = {
                  uid: booking.uid,
                  attendees: booking.attendees.map((attendee) => {
                    return { name: attendee.name, email: attendee.email, timeZone: attendee.timeZone };
                  }),
                  organizer: booking.user
                    ? {
                        name: booking.user.name || "",
                        email: booking.user.email,
                        timeZone: booking.user.timeZone,
                      }
                    : { name: "", email: "", timeZone: "" },
                  startTime: booking.startTime.toISOString(),
                  title: booking.title,
                };
                if (
                  step.action === WorkflowActions.EMAIL_HOST ||
                  step.action === WorkflowActions.EMAIL_ATTENDEE
                ) {
                  const sendTo =
                    step.action === WorkflowActions.EMAIL_HOST
                      ? bookingInfo.organizer?.email
                      : bookingInfo.attendees[0].email;
                  await scheduleEmailReminder(
                    bookingInfo,
                    WorkflowTriggerEvents.BEFORE_EVENT,
                    step.action,
                    {
                      time,
                      timeUnit,
                    },
                    sendTo,
                    step.emailSubject || "",
                    step.reminderBody || "",
                    step.id,
                    step.template
                  );
                } else if (step.action === WorkflowActions.SMS_NUMBER) {
                  await scheduleSMSReminder(
                    bookingInfo,
                    step.sendTo || "",
                    WorkflowTriggerEvents.BEFORE_EVENT,
                    step.action,
                    {
                      time,
                      timeUnit,
                    },
                    step.reminderBody || "",
                    step.id,
                    step.template
                  );
                }
              });
            }
          });
        }
        //create all workflow - eventtypes relationships
        activeOn.forEach(async (eventTypeId) => {
          await ctx.prisma.workflowsOnEventTypes.createMany({
            data: {
              workflowId: id,
              eventTypeId,
            },
          });
        });
      }

      userWorkflow.steps.map(async (oldStep) => {
        const newStep = steps.filter((s) => s.id === oldStep.id)[0];
        const remindersFromStep = await ctx.prisma.workflowReminder.findMany({
          where: {
            workflowStepId: oldStep.id,
          },
          include: {
            booking: true,
          },
        });
        //step was deleted
        if (!newStep) {
          //delete already scheduled reminders
          if (remindersFromStep.length > 0) {
            remindersFromStep.forEach((reminder) => {
              if (reminder.referenceId) {
                if (reminder.method === WorkflowMethods.EMAIL) {
                  deleteScheduledEmailReminder(reminder.referenceId);
                } else if (reminder.method === WorkflowMethods.SMS) {
                  deleteScheduledSMSReminder(reminder.referenceId);
                }
              }
            });
          }
          await ctx.prisma.workflowStep.delete({
            where: {
              id: oldStep.id,
            },
          });
          //step was edited
        } else if (JSON.stringify(oldStep) !== JSON.stringify(newStep)) {
          await ctx.prisma.workflowStep.update({
            where: {
              id: oldStep.id,
            },
            data: {
              action: newStep.action,
              sendTo: newStep.action === WorkflowActions.SMS_NUMBER ? newStep.sendTo : null,
              stepNumber: newStep.stepNumber,
              workflowId: newStep.workflowId,
              reminderBody: newStep.template === WorkflowTemplates.CUSTOM ? newStep.reminderBody : null,
              emailSubject: newStep.template === WorkflowTemplates.CUSTOM ? newStep.emailSubject : null,
              template: newStep.template,
            },
          });
          //cancel all reminders of step and create new ones (not for newEventTypes)
          const remindersToUpdate = remindersFromStep.filter((reminder) => {
            if (reminder.booking?.eventTypeId && !newEventTypes.includes(reminder.booking?.eventTypeId)) {
              return reminder;
            }
          });
          remindersToUpdate.forEach(async (reminder) => {
            if (reminder.referenceId) {
              if (reminder.method === WorkflowMethods.EMAIL) {
                deleteScheduledEmailReminder(reminder.referenceId);
              } else if (reminder.method === WorkflowMethods.SMS) {
                deleteScheduledSMSReminder(reminder.referenceId);
              }
            }
            await ctx.prisma.workflowReminder.deleteMany({
              where: {
                id: reminder.id,
              },
            });
          });
          const eventTypesToUpdateReminders = activeOn.filter((eventTypeId) => {
            if (!newEventTypes.includes(eventTypeId)) {
              return eventTypeId;
            }
          });
          if (eventTypesToUpdateReminders && trigger === WorkflowTriggerEvents.BEFORE_EVENT) {
            const bookingsOfEventTypes = await ctx.prisma.booking.findMany({
              where: {
                eventTypeId: {
                  in: eventTypesToUpdateReminders,
                },
                status: BookingStatus.ACCEPTED,
                startTime: {
                  gte: new Date(),
                },
              },
              include: {
                attendees: true,
                eventType: true,
                user: true,
              },
            });
            bookingsOfEventTypes.forEach(async (booking) => {
              const bookingInfo = {
                uid: booking.uid,
                attendees: booking.attendees.map((attendee) => {
                  return { name: attendee.name, email: attendee.email, timeZone: attendee.timeZone };
                }),
                organizer: booking.user
                  ? {
                      name: booking.user.name || "",
                      email: booking.user.email,
                      timeZone: booking.user.timeZone,
                    }
                  : { name: "", email: "", timeZone: "" },
                startTime: booking.startTime.toISOString(),
                title: booking.title,
              };
              if (
                newStep.action === WorkflowActions.EMAIL_HOST ||
                newStep.action === WorkflowActions.EMAIL_ATTENDEE
              ) {
                const sendTo =
                  newStep.action === WorkflowActions.EMAIL_HOST
                    ? bookingInfo.organizer?.email
                    : bookingInfo.attendees[0].email;
                await scheduleEmailReminder(
                  bookingInfo,
                  WorkflowTriggerEvents.BEFORE_EVENT,
                  newStep.action,
                  {
                    time,
                    timeUnit,
                  },
                  sendTo,
                  newStep.emailSubject || "",
                  newStep.reminderBody || "",
                  newStep.id,
                  newStep.template
                );
              } else if (newStep.action === WorkflowActions.SMS_NUMBER) {
                await scheduleSMSReminder(
                  bookingInfo,
                  newStep.sendTo || "",
                  WorkflowTriggerEvents.BEFORE_EVENT,
                  newStep.action,
                  {
                    time,
                    timeUnit,
                  },
                  newStep.reminderBody || "",
                  newStep.id || 0,
                  newStep.template
                );
              }
            });
          }
        }
      });
      //added steps
      const addedSteps = steps.map((s) => {
        if (s.id <= 0) {
          const { id, ...stepToAdd } = s;
          if (stepToAdd) {
            return stepToAdd;
          }
        }
      });

      if (addedSteps) {
        const eventTypesToCreateReminders = activeOn.map((activeEventType) => {
          if (activeEventType && !newEventTypes.includes(activeEventType)) {
            return activeEventType;
          }
        });
        addedSteps.forEach(async (step) => {
          if (step) {
            const createdStep = await ctx.prisma.workflowStep.create({
              data: step,
            });
            if (
              trigger === WorkflowTriggerEvents.BEFORE_EVENT &&
              eventTypesToCreateReminders &&
              step.action !== WorkflowActions.SMS_ATTENDEE
            ) {
              const bookingsForReminders = await ctx.prisma.booking.findMany({
                where: {
                  eventTypeId: { in: eventTypesToCreateReminders as number[] },
                  status: BookingStatus.ACCEPTED,
                  startTime: {
                    gte: new Date(),
                  },
                },
                include: {
                  attendees: true,
                  eventType: true,
                  user: true,
                },
              });
              bookingsForReminders.forEach(async (booking) => {
                const bookingInfo = {
                  uid: booking.uid,
                  attendees: booking.attendees.map((attendee) => {
                    return { name: attendee.name, email: attendee.email, timeZone: attendee.timeZone };
                  }),
                  organizer: booking.user
                    ? {
                        name: booking.user.name || "",
                        email: booking.user.email,
                        timeZone: booking.user.timeZone,
                      }
                    : { name: "", email: "", timeZone: "" },
                  startTime: booking.startTime.toISOString(),
                  title: booking.title,
                };

                if (
                  step.action === WorkflowActions.EMAIL_ATTENDEE ||
                  step.action === WorkflowActions.EMAIL_HOST
                ) {
                  const sendTo =
                    step.action === WorkflowActions.EMAIL_HOST
                      ? bookingInfo.organizer?.email
                      : bookingInfo.attendees[0].email;
                  await scheduleEmailReminder(
                    bookingInfo,
                    trigger,
                    step.action,
                    {
                      time,
                      timeUnit,
                    },
                    sendTo,
                    step.emailSubject || "",
                    step.reminderBody || "",
                    createdStep.id,
                    step.template
                  );
                } else if (step.action === WorkflowActions.SMS_NUMBER && step.sendTo) {
                  await scheduleSMSReminder(
                    bookingInfo,
                    step.sendTo,
                    WorkflowTriggerEvents.BEFORE_EVENT,
                    step.action,
                    {
                      time,
                      timeUnit,
                    },
                    step.reminderBody || "",
                    createdStep.id,
                    step.template
                  );
                }
              });
            }
          }
        });
      }

      //update trigger, name, time, timeUnit
      await ctx.prisma.workflow.update({
        where: {
          id,
        },
        data: {
          name,
          trigger,
          time,
          timeUnit,
        },
      });

      const workflow = await ctx.prisma.workflow.findFirst({
        where: {
          id,
        },
        include: {
          activeOn: {
            select: {
              eventType: true,
            },
          },
          steps: true,
        },
      });

      return {
        workflow,
      };
    },
  });
