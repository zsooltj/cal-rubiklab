//TODO: Generate this file automatically so that like in Next.js file based routing can work automatically
import * as formEdit from "./form-edit/[...appPages]";
import * as forms from "./forms/[...appPages]";
import * as RouteBuilder from "./route-builder/[...appPages]";
import * as RoutingLink from "./routing-link/[...appPages]";

const routingConfig = {
  "form-edit": formEdit,
  "route-builder": RouteBuilder,
  forms: forms,
  "routing-link": RoutingLink,
};

export default routingConfig;
