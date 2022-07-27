import { expect } from "@playwright/test";

import { test } from "./lib/fixtures";
import { bookTimeSlot, selectFirstAvailableTimeSlotNextMonth } from "./lib/testUtils";

test.describe.configure({ mode: "parallel" });

test.describe("hash my url", () => {
  test.beforeEach(async ({ users }) => {
    const user = await users.create();
    await user.login();
  });
  test.afterEach(async ({ users }) => {
    await users.deleteAll();
  });
  test("generate url hash", async ({ page }) => {
    // await page.pause();
    await page.goto("/event-types");
    // We wait until loading is finished
    await page.waitForSelector('[data-testid="event-types"]');
    await page.click('//ul[@data-testid="event-types"]/li[1]');
    // We wait for the page to load
    await page.waitForSelector('//*[@data-testid="show-advanced-settings"]');
    await page.click('//*[@data-testid="show-advanced-settings"]');
    // we wait for the hashedLink setting to load
    await page.waitForSelector('//*[@id="hashedLinkCheck"]');
    // ignore if it is already checked, and click if unchecked
    const isChecked = await page.isChecked('//*[@id="hashedLinkCheck"]');
    !isChecked && (await page.click('//*[@id="hashedLinkCheck"]'));
    // we wait for the hashedLink setting to load
    await page.waitForSelector('//*[@data-testid="generated-hash-url"]');
    const $url = await page.locator('//*[@data-testid="generated-hash-url"]').inputValue();
    // click update
    await page.focus('//button[@type="submit"]');
    await page.keyboard.press("Enter");

    // To prevent an early 404
    // eslint-disable-next-line playwright/no-wait-for-timeout
    await page.waitForTimeout(1000);

    // book using generated url hash
    await page.goto($url);
    await selectFirstAvailableTimeSlotNextMonth(page);
    await bookTimeSlot(page);
    // Make sure we're navigated to the success page
    await expect(page.locator("[data-testid=success-page]")).toBeVisible();

    // hash regenerates after successful booking
    await page.goto("/event-types");
    // We wait until loading is finished
    await page.waitForSelector('[data-testid="event-types"]');
    await page.click('//ul[@data-testid="event-types"]/li[1]');
    // We wait for the page to load
    await page.waitForSelector('//*[@data-testid="show-advanced-settings"]');
    await page.click('//*[@data-testid="show-advanced-settings"]');
    // we wait for the hashedLink setting to load
    await page.waitForSelector('//*[@data-testid="generated-hash-url"]');
    const $newUrl = await page.locator('//*[@data-testid="generated-hash-url"]').inputValue();
    expect($url !== $newUrl).toBeTruthy();
  });
});
