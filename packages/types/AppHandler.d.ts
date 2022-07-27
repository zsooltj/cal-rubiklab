import { NextApiHandler } from "next";
import { Session } from "next-auth";

import { Credential } from "@calcom/prisma/client";

export type AppDeclarativeHandler = {
  appType: string;
  slug: string;
  supportsMultipleInstalls: false;
  handlerType: "add";
  createCredential: (arg: { user: Session["user"]; appType: string; slug: string }) => Promise<Credential>;
  supportsMultipleInstalls: boolean;
  redirectUrl: string;
};
export type AppHandler = AppDeclarativeHandler | NextApiHandler;
