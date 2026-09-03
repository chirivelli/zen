/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const SPLIT_LINK_TEST_PAGE = `https://example.com/document-builder.sjs?html=${encodeURIComponent(`
  <!doctype html>
  <a id="split-link" href="https://example.org/">open me</a>
`)}`;

add_task(async function test_splitLinkWithCurrentTab() {
  const tab = await addTabTo(gBrowser, getUrlForNthTab(1));
  gBrowser.selectedTab = tab;

  const waitForSplitPromise = BrowserTestUtils.waitForEvent(
    window,
    "ZenViewSplitter:SplitViewActivated"
  );
  const newTab = gZenViewSplitter.splitLinkWithCurrentTab(
    "https://example.com/",
    Services.scriptSecurityManager.getSystemPrincipal()
  );
  await waitForSplitPromise;

  ok(newTab, "A new tab should be opened for the split link");
  ok(
    gBrowser.tabpanels.hasAttribute("zen-split-view"),
    "Option-click split should activate split view"
  );
  Assert.equal(tab.group, newTab.group, "Both tabs should share a split group");
  ok(
    tab.group.hasAttribute("split-view-group"),
    "The original tab should be in a split group"
  );

  await BrowserTestUtils.removeTab(newTab);
  await BrowserTestUtils.removeTab(tab);
});

add_task(async function test_alt_click_opens_split_when_glance_uses_shift() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["zen.glance.enabled", true],
      ["zen.glance.activation-method", "shift"],
      ["zen.splitView.alt-click-open", true],
    ],
  });

  const tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    SPLIT_LINK_TEST_PAGE
  );
  const waitForSplitPromise = BrowserTestUtils.waitForEvent(
    window,
    "ZenViewSplitter:SplitViewActivated"
  );

  await BrowserTestUtils.synthesizeMouseAtCenter(
    "#split-link",
    { altKey: true },
    tab.linkedBrowser
  );
  await waitForSplitPromise;

  const splitTabs = gBrowser.tabs.filter(t => t.splitView);
  Assert.equal(
    splitTabs.length,
    2,
    "Alt/Option + click should split the link with the current tab"
  );
  ok(
    !gBrowser.selectedTab.hasAttribute("zen-glance-tab"),
    "Alt/Option + click should not open glance when glance uses shift"
  );

  for (const splitTab of [...splitTabs]) {
    await BrowserTestUtils.removeTab(splitTab);
  }
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_alt_click_keeps_glance_when_glance_uses_alt() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["zen.glance.enabled", true],
      ["zen.glance.activation-method", "alt"],
      ["zen.splitView.alt-click-open", true],
    ],
  });

  const tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    SPLIT_LINK_TEST_PAGE
  );

  const glanceOpened = BrowserTestUtils.waitForCondition(
    () => gBrowser.selectedTab.hasAttribute("zen-glance-tab"),
    "Glance should open for Alt + click when glance uses alt"
  );

  await BrowserTestUtils.synthesizeMouseAtCenter(
    "#split-link",
    { altKey: true },
    tab.linkedBrowser
  );
  await glanceOpened;

  ok(
    !gBrowser.tabpanels.hasAttribute("zen-split-view"),
    "Glance should win over split when both would use Alt + click"
  );

  await gZenGlanceManager.closeGlance({ onTabClose: true });
  await BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
});
