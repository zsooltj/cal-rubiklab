import prisma from "@calcom/prisma";
import { App } from "@calcom/types/App";

export async function getAppWithMetadata(app: { dirName: string }) {
  let appMetadata: App | null = null;
  try {
    appMetadata = (await import(`./${app.dirName}/_metadata`)).default as App;
  } catch (error) {
    try {
      appMetadata = (await import(`./ee/${app.dirName}/_metadata`)).default as App;
    } catch (e) {
      if (error instanceof Error) {
        console.error(`No metadata found for: "${app.dirName}". Message:`, error.message);
      }
      return null;
    }
  }
  if (!appMetadata) return null;
  // Let's not leak api keys to the front end
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { key, ...metadata } = appMetadata;
  return metadata;
}

/** Mainly to use in listings for the frontend, use in getStaticProps or getServerSideProps */
export async function getAppRegistry() {
  const dbApps = await prisma.app.findMany({ select: { dirName: true, slug: true, categories: true } });
  const apps = [] as Omit<App, "key">[];
  for await (const dbapp of dbApps) {
    const app = await getAppWithMetadata(dbapp);
    if (!app) continue;
    // Skip if app isn't installed
    /* This is now handled from the DB */
    // if (!app.installed) return apps;
    apps.push({
      ...app,
      installed:
        true /* All apps from DB are considered installed by default. @TODO: Add and filter our by `enabled` property */,
    });
  }
  return apps;
}
