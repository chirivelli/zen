/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

/**
 * Tests that Tab on a matching site suggestion enters that site's search mode
 * without requiring an "@" keyword.
 */

ChromeUtils.defineESModuleGetters(this, {
  UrlbarTestUtils: "resource://testing-common/UrlbarTestUtils.sys.mjs",
  ZenTabToSearch: "resource:///modules/ZenTabToSearch.sys.mjs",
  SearchService: "moz-src:///toolkit/components/search/SearchService.sys.mjs",
});

const TEST_ENGINE_NAME = "ZenTabToSearchTest";
const TEST_ENGINE_DOMAIN = "zen-tab-search.example.com";

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["zen.urlbar.tab-to-search.enabled", true],
      ["browser.urlbar.scotchBonnet.enableOverride", false],
      ["browser.urlbar.suggest.engines", true],
    ],
  });

  await SearchTestUtils.installSearchExtension({
    name: TEST_ENGINE_NAME,
    search_url: `https://${TEST_ENGINE_DOMAIN}/search`,
    search_url_get_params: "q={searchTerms}",
  });

  await ZenTabToSearch.init();

  registerCleanupFunction(async () => {
    await PlacesUtils.history.clear();
  });
});

add_task(async function test_tab_enters_site_search_mode() {
  await PlacesUtils.history.clear();
  for (let i = 0; i < 3; i++) {
    await PlacesTestUtils.addVisits(`https://${TEST_ENGINE_DOMAIN}/`);
  }
  await PlacesFrecencyRecalculator.recalculateAnyOutdatedFrecencies();

  // Ensure the domain→engine cache includes our test engine.
  await ZenTabToSearch.init();

  await UrlbarTestUtils.promiseAutocompleteResultPopup({
    window,
    value: TEST_ENGINE_DOMAIN,
    fireInputEvent: true,
  });

  // Prefer a selected URL-like result when available.
  if (UrlbarTestUtils.getSelectedRowIndex(window) < 0) {
    EventUtils.synthesizeKey("KEY_ArrowDown");
  }

  let engineBefore = ZenTabToSearch.engineForHostOrUrl(TEST_ENGINE_DOMAIN);
  Assert.ok(engineBefore, "Cache should resolve an engine for the test domain");
  Assert.equal(
    engineBefore.name,
    TEST_ENGINE_NAME,
    "Resolved engine should be the test engine"
  );

  EventUtils.synthesizeKey("KEY_Tab");

  await TestUtils.waitForCondition(
    () => gURLBar.searchMode?.engineName == TEST_ENGINE_NAME,
    "Should enter search mode for the matching site engine"
  );

  await UrlbarTestUtils.assertSearchMode(window, {
    engineName: TEST_ENGINE_NAME,
    entry: "tabtosearch",
  });

  await UrlbarTestUtils.exitSearchMode(window);
  await UrlbarTestUtils.promisePopupClose(window, () => gURLBar.blur());
});

add_task(async function test_pref_disables_tab_to_search() {
  await SpecialPowers.pushPrefEnv({
    set: [["zen.urlbar.tab-to-search.enabled", false]],
  });

  await UrlbarTestUtils.promiseAutocompleteResultPopup({
    window,
    value: TEST_ENGINE_DOMAIN,
    fireInputEvent: true,
  });

  EventUtils.synthesizeKey("KEY_Tab");

  Assert.notEqual(
    gURLBar.searchMode?.engineName,
    TEST_ENGINE_NAME,
    "Tab should not enter site search mode when the feature is disabled"
  );

  await UrlbarTestUtils.promisePopupClose(window, () => gURLBar.blur());
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_preset_install_uninstall() {
  const presetId = "youtube";
  // Clean slate if a previous run left YouTube installed.
  if (await ZenTabToSearch.isPresetInstalled(presetId)) {
    await ZenTabToSearch.uninstallPreset(presetId);
  }

  Assert.ok(
    !(await ZenTabToSearch.isPresetInstalled(presetId)),
    "YouTube preset should not be installed initially"
  );

  await ZenTabToSearch.installPreset(presetId);
  Assert.ok(
    await ZenTabToSearch.isPresetInstalled(presetId),
    "YouTube preset should be installed"
  );

  let engine = ZenTabToSearch.engineForHostOrUrl("youtube.com");
  Assert.ok(engine, "youtube.com should resolve to an engine after install");
  Assert.equal(engine.name, "YouTube", "Engine name should be YouTube");

  await ZenTabToSearch.uninstallPreset(presetId);
  Assert.ok(
    !(await ZenTabToSearch.isPresetInstalled(presetId)),
    "YouTube preset should be removed"
  );
});
