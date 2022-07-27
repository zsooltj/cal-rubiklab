import { ComponentMeta } from "@storybook/react";

import { Breadcrumb, BreadcrumbItem } from "@calcom/ui/v2";

export default {
  title: "Breadcrumbs",
  component: Breadcrumb,
} as ComponentMeta<typeof Breadcrumb>;

export const Default = () => (
  <Breadcrumb>
    <BreadcrumbItem href="/">Home</BreadcrumbItem>
    <BreadcrumbItem href="/">Test</BreadcrumbItem>
  </Breadcrumb>
);

Default.parameters = {
  nextRouter: {
    path: "/test",
    asPath: "/test",
  },
};
