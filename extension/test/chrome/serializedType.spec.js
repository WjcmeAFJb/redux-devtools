import { resolve } from 'path';
import webdriver from 'selenium-webdriver';
import chrome from 'selenium-webdriver/chrome';
import { delay } from '../utils/e2e.js';

const extensionPath = resolve(import.meta.dirname, '..', '..', 'dist');
const extensionId = 'lmhkpmbekcpmknklioeibfkpmmfibljd';
const fixtureUrl =
  'file://' + resolve(import.meta.dirname, 'fixture', 'serialized-type.html');

// Reproduces the raw-API bug:
//   1. Page initializes the extension via connect({serialize:true})+init()
//      with a value that uses __serializedType__.
//   2. DevTools panel is opened AFTER step 1.
//
// Before the fix, the panel rendered the literal property names
// ("__serializedType__", "data") because the cached STATE the background
// re-sent to the panel did not carry libConfig.serialize=true, so the
// reducer's parseJSON skipped the reviver.
//
// After the fix, the panel receives libConfig.serialize=true with that
// cached STATE and shows the tag ("FixtureTag") on the wrapped value.
describe('Raw-API __serializedType__ — panel opened after page init', function () {
  let driver;

  beforeAll(async () => {
    driver = new webdriver.Builder()
      .setChromeOptions(
        new chrome.Options()
          .setBrowserVersion('stable')
          .addArguments(`load-extension=${extensionPath}`),
      )
      .forBrowser('chrome')
      .build();
  });

  afterAll(async () => {
    if (driver) await driver.quit();
  });

  it('renders the type tag in the state tree', async () => {
    // The initial session has one blank tab. Load the fixture page into
    // it first — this is what reproduces the bug: the extension panel is
    // NOT yet open when the page calls connect()+init().
    await driver.get(fixtureUrl);
    await driver.wait(
      async () => {
        const txt = await driver
          .findElement(webdriver.By.id('status'))
          .getText();
        return txt === 'initialized';
      },
      15000,
      'fixture page never reported initialized',
    );

    // Now open the devtools panel in a new tab. Using switchTo().newWindow
    // instead of `window.open` — Chrome blocks page-initiated navigation to
    // chrome-extension:// URLs for security.
    await driver.switchTo().newWindow('tab');
    await driver.get(`chrome-extension://${extensionId}/devpanel.html`);
    await delay(2500);

    // The panel defaults to Inspector monitor. Wait for the instance to
    // appear in the action list.
    await driver.wait(
      driver.findElement(
        webdriver.By.xpath('//div[@data-testid="actionListRows"]'),
      ),
      15000,
      'action list did not render',
    );

    // Click on the @@INIT row to select it and show the state.
    const initRow = await driver.findElement(
      webdriver.By.xpath(
        '//div[@data-testid="actionListRows"]//div[text()="@@INIT"]',
      ),
    );
    await initRow.click();
    await delay(800);

    // Switch to the "State" tab — tab labels are plain divs, not buttons.
    const stateTab = await driver.findElement(
      webdriver.By.xpath('//div[normalize-space(text())="State"]'),
    );
    await stateTab.click();
    await delay(800);

    // The state tree is rendered inline — grab the whole inspector area.
    const inspector = await driver.findElement(
      webdriver.By.xpath('//div[@data-testid="inspector"]'),
    );
    // Click every collapsible arrow to expand the whole tree.
    await driver.executeScript(
      `Array.from(document.querySelectorAll('[role="button"]')).forEach((n) => {
         const txt = (n.textContent || '').trim();
         if (!txt.startsWith('@@INIT') && n.getAttribute('aria-expanded') !== 'true') {
           n.click();
         }
       });`,
    );
    await delay(300);
    const stateText = await inspector.getText();

    // The fix: the custom tag "FixtureTag" should appear in the state tree.
    expect(stateText).toContain('FixtureTag');

    // Before the fix, the literal "__serializedType__" string was rendered
    // as an object key. After the fix, that key has been converted into the
    // type tag and should no longer appear as a property name.
    expect(stateText).not.toContain('__serializedType__');
  }, 60000);
});
