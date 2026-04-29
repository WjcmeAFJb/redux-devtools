import { resolve } from 'path';
import webdriver, { By } from 'selenium-webdriver';
import chrome from 'selenium-webdriver/chrome';
import { delay } from '../utils/e2e.js';

const extensionPath = resolve(import.meta.dirname, '..', '..', 'dist');
const extensionId = 'lmhkpmbekcpmknklioeibfkpmmfibljd';
const fixtureUrl =
  'file://' + resolve(import.meta.dirname, 'fixture', 'custom-stack.html');

describe('connect().send custom stack', function () {
  let driver;

  beforeAll(async () => {
    driver = new webdriver.Builder()
      .setChromeOptions(
        new chrome.Options()
          .setBrowserVersion('stable')
          .windowSize({ width: 1280, height: 800 })
          .addArguments(`load-extension=${extensionPath}`),
      )
      .forBrowser('chrome')
      .build();
  });

  afterAll(async () => {
    if (driver) await driver.quit();
  });

  it('renders the integration-supplied stack on the Trace tab', async () => {
    // Open the panel first so the connect() instance is registered while
    // the panel is listening — that's the fast path; this test isn't
    // about the late-panel bug, just about the new options.stack arg.
    await driver.get(`chrome-extension://${extensionId}/devpanel.html`);
    await delay(1500);

    await driver.switchTo().newWindow('tab');
    await driver.get(fixtureUrl);
    await driver.wait(
      async () => {
        const txt = await driver
          .findElement(By.id('status'))
          .getText()
          .catch(() => '');
        return txt === 'sent';
      },
      15000,
      'fixture never finished',
    );

    // Switch back to the panel.
    const tabs = await driver.getAllWindowHandles();
    await driver.switchTo().window(tabs[0]);
    await delay(1500);

    // The fixture's `name` from connect() shows up in the instance picker.
    // Default selection lands on it because there's only one.
    await driver.wait(
      driver.findElement(
        By.xpath('//div[@data-testid="actionListRows"]'),
      ),
      15000,
      'action list did not render',
    );

    const customRow = await driver.findElement(
      By.xpath(
        '//div[@data-testid="actionListRows"]//div[text()="CUSTOM_ACTION"]',
      ),
    );
    await customRow.click();
    await delay(500);

    const traceTab = await driver.findElement(
      By.xpath('//div[normalize-space(text())="Trace"]'),
    );
    await traceTab.click();
    await delay(800);

    const inspector = await driver.findElement(
      By.xpath('//div[@data-testid="inspector"]'),
    );
    const text = await inspector.getText();

    // The trace tab parses the integration-supplied stack and renders the
    // function names that appear in the file:line:col entries.
    expect(text).toContain('simulatedMobxReaction');
    expect(text).toContain('simulatedBatchScheduler');
    expect(text).toContain('simulatedDomEvent');

    // The JS call site of `devTools.send(...)` (the fixture HTML) should
    // NOT leak in even though config.trace is true — the integration's
    // explicit stack fully replaces the auto-captured one.
    expect(text).not.toContain('custom-stack.html');

    // Now the second action that was sent WITHOUT a custom stack: it
    // should still get an auto-captured trace because config.trace=true
    // (no regression). That trace will reference the fixture file.
    const autoRow = await driver.findElement(
      By.xpath(
        '//div[@data-testid="actionListRows"]//div[text()="AUTO_TRACED"]',
      ),
    );
    await autoRow.click();
    await delay(500);
    const autoText = await inspector.getText();
    expect(autoText).toContain('custom-stack.html');
    // And of course the auto trace should NOT contain the integration's
    // simulated frames.
    expect(autoText).not.toContain('simulatedMobxReaction');
  }, 60000);
});
