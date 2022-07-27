import { useLocale } from "@calcom/lib/hooks/useLocale";
import showToast from "@calcom/lib/notification";
import { trpc } from "@calcom/trpc/react";
import Button from "@calcom/ui/Button";

import Badge from "@components/ui/Badge";

const DisableUserImpersonation = ({ disableImpersonation }: { disableImpersonation: boolean }) => {
  const utils = trpc.useContext();

  const { t } = useLocale();

  const mutation = trpc.useMutation("viewer.updateProfile", {
    onSuccess: async () => {
      showToast(t("your_user_profile_updated_successfully"), "success");
      await utils.invalidateQueries(["viewer.me"]);
    },
    async onSettled() {
      await utils.invalidateQueries(["viewer.public.i18n"]);
    },
  });

  return (
    <>
      <div className="flex flex-col justify-between pt-9 pl-2 sm:flex-row">
        <div>
          <div className="flex flex-row items-center">
            <h2 className="font-cal text-lg font-medium leading-6 text-gray-900">
              {t("user_impersonation_heading")}
            </h2>
            <Badge className="ml-2 text-xs" variant={!disableImpersonation ? "success" : "gray"}>
              {!disableImpersonation ? t("enabled") : t("disabled")}
            </Badge>
          </div>
          <p className="mt-1 text-sm text-gray-500">{t("user_impersonation_description")}</p>
        </div>
        <div className="mt-5 sm:mt-0 sm:self-center">
          <Button
            type="submit"
            color="secondary"
            onClick={() =>
              !disableImpersonation
                ? mutation.mutate({ disableImpersonation: true })
                : mutation.mutate({ disableImpersonation: false })
            }>
            {!disableImpersonation ? t("disable") : t("enable")}
          </Button>
        </div>
      </div>
    </>
  );
};

export default DisableUserImpersonation;
