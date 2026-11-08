// 通しテスト: iPad（テーブル）1 台とスマホ 3〜4 台で、ロビーから最終結果まで流す。
// スマホは ?bot=1 の自動操作で動かし、テーブルの画面は人が触るのと同じようにクリックする。
import { devices, expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

const TABLE = devices['iPad Pro 11 landscape'];
const PHONE = devices['iPhone 13'];

interface Device {
  ctx: BrowserContext;
  page: Page;
  errors: string[];
}

// テストごとに開いた端末。閉じないと、前のテストのボットが裏で動き続けて遅くなる
const opened: BrowserContext[] = [];
test.afterEach(async () => {
  await Promise.all(opened.splice(0).map((c) => c.close()));
});

async function open(browser: Browser, device: (typeof devices)[string], path: string): Promise<Device> {
  // browserName は設定で webkit に固定しているので、端末の defaultBrowserType は外す
  const { defaultBrowserType: _, ...opts } = device;
  const ctx = await browser.newContext(opts);
  opened.push(ctx);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`${path}: ${e.message}`));
  await page.goto(path);
  return { ctx, page, errors };
}

async function openTable(browser: Browser) {
  const t = await open(browser, TABLE, '/table');
  await t.page.waitForURL(/\/table\/[A-Z2-9]{6}$/);
  const roomId = t.page.url().match(/\/table\/([A-Z2-9]{6})$/)![1]!;
  await expect(t.page.getByLabel('ルームコード')).toContainText(roomId);
  return { ...t, roomId };
}

const bot = (browser: Browser, roomId: string, name: string) => open(browser, PHONE, `/play/${roomId}?name=${encodeURIComponent(name)}&bot=1`);

/** ステッパーの値が目標になるまで押す */
async function setGames(page: Page, n: number) {
  const group = page.getByRole('group', { name: 'ゲーム数' }).or(page.locator('.stepper', { hasText: 'ゲーム数' }));
  for (let i = 0; i < 20; i++) {
    const text = (await group.first().textContent()) ?? '';
    const cur = Number(text.match(/(\d+) ゲーム/)?.[1] ?? NaN);
    if (cur === n) return;
    await page.getByRole('button', { name: cur - n >= 5 ? 'ゲーム数を 5 減らす' : cur > n ? 'ゲーム数を 1 減らす' : 'ゲーム数を 1 増やす' }).click();
  }
  throw new Error(`ゲーム数を ${n} にできない`);
}

/** テーブルの「次のゲームへ」「最終結果を見る」を押しながら、最終結果まで進める。通ったフェーズを返す */
async function playToEnd(table: Page, games: number) {
  const seen = new Set<string>();
  const deadline = Date.now() + games * 150_000;
  while (Date.now() < deadline) {
    if (await table.locator('.finished').isVisible()) return seen;
    const phase = await table.locator('[data-phase]').getAttribute('data-phase', { timeout: 1_000 }).catch(() => null);
    if (phase) seen.add(phase);
    if (await table.locator('.betting').isVisible()) seen.add('betting');
    const next = table.getByRole('button', { name: /次のゲームへ|最終結果を見る/ });
    if (await next.isVisible()) await next.click().catch(() => {});
    await table.waitForTimeout(500);
  }
  throw new Error(`最終結果に届かない（通ったフェーズ: ${[...seen].join(', ')}）`);
}

test('ボット 4 人で 2 ゲーム遊び、最終結果まで進む（固定ベット）', async ({ browser }) => {
  const table = await openTable(browser);
  const names = ['はるか', 'そうた', 'みお', 'りく'];
  const phones = await Promise.all(names.map((n) => bot(browser, table.roomId, n)));
  for (const n of names) await expect(table.page.locator('body')).toContainText(n);
  await setGames(table.page, 2);
  await table.page.getByRole('button', { name: '4 人で対局を始める' }).click();

  const seen = await playToEnd(table.page, 2);
  for (const p of ['placement', 'reveal', 'result']) expect(seen, `通ったフェーズ: ${[...seen].join(', ')}`).toContain(p);
  console.log(`通ったフェーズ: ${[...seen].join(', ')}`);

  await expect(table.page.locator('.final-list li')).toHaveCount(4);
  await expect(table.page.getByText('2 ゲーム遊びました')).toBeVisible();
  for (const ph of phones) await expect(ph.page.locator('.ply')).not.toContainText('卓につく');
  expect([table, ...phones].flatMap((d) => d.errors)).toEqual([]);
});

test('持ち回りベットと持ち時間なしで、親がベットを決めてゲームが始まる', async ({ browser }) => {
  const table = await openTable(browser);
  const names = ['あおい', 'けんた', 'ゆな'];
  const phones = await Promise.all(names.map((n) => bot(browser, table.roomId, n)));
  for (const n of names) await expect(table.page.locator('body')).toContainText(n);
  await table.page.getByRole('radiogroup', { name: 'ベット方式' }).getByRole('radio', { name: '持ち回り' }).click();
  await table.page.getByRole('radiogroup', { name: '持ち時間' }).getByRole('radio', { name: 'なし' }).click();
  await setGames(table.page, 1);
  await table.page.getByRole('button', { name: '3 人で対局を始める' }).click();

  // 親を決める画面がテーブルに出て、親のボットが選ぶと配置に進む
  await expect(table.page.getByText('がベット額を決めています')).toBeVisible();
  await expect(table.page.locator('[data-phase="placement"]')).toBeVisible({ timeout: 20_000 });
  // 持ち時間なしでは一時停止ボタンを出さない
  await expect(table.page.getByRole('button', { name: /持ち時間を(止める|再開)/ })).toHaveCount(0);

  await playToEnd(table.page, 1);
  await expect(table.page.locator('.final-list li')).toHaveCount(3);
  expect([table, ...phones].flatMap((d) => d.errors)).toEqual([]);
});

test('人がコードを入れて参加し、途中で読み込み直しても続きから戻れる', async ({ browser }) => {
  const table = await openTable(browser);

  // 1 人目は人として、ホーム画面からコードを入れて参加する
  const human = await open(browser, PHONE, '/');
  await human.page.getByLabel('テーブルのコード').fill(table.roomId);
  await human.page.getByRole('button', { name: '参加する' }).click();
  await human.page.getByLabel('テーブルでの呼び名').fill('ゆき');
  await human.page.getByRole('button', { name: '卓につく' }).click();
  await expect(human.page.getByText('ゆき さん、ようこそ')).toBeVisible();
  await expect(table.page.locator('body')).toContainText('ゆき');

  // 3 人目までは始められない
  const others = [await bot(browser, table.roomId, 'はるか')];
  await expect(table.page.getByRole('button', { name: 'あと 1 人で始められます' })).toBeDisabled();
  others.push(await bot(browser, table.roomId, 'そうた'));
  await table.page.getByRole('button', { name: '3 人で対局を始める' }).click();
  await expect(table.page.locator('[data-phase="placement"]')).toBeVisible();

  // 持ち時間を止めて、また動かせる
  await table.page.getByRole('button', { name: /持ち時間を止める/ }).click();
  await expect(table.page.getByRole('button', { name: /持ち時間を再開/ })).toBeVisible();
  await table.page.getByRole('button', { name: /持ち時間を再開/ }).click();
  await expect(table.page.getByRole('button', { name: /持ち時間を止める/ })).toBeVisible();

  // 人のスマホとテーブルを読み込み直しても、参加し直さずにゲームへ戻る
  await human.page.reload();
  await expect(human.page.locator('.ply')).not.toContainText('卓につく');
  await expect(human.page.locator('.ply')).not.toContainText('つないでいます');
  await table.page.reload();
  await expect(table.page.locator('[data-phase]')).toBeVisible();

  // ボットのスマホを読み込み直しても、同じ席に戻る（名前が増えない）
  await others[0]!.page.reload();
  await expect(others[0]!.page.locator('.ply')).not.toContainText('卓につく');
  await expect(table.page.locator('.seat, [class*="seat"]').filter({ hasText: 'はるか' }).first()).toBeVisible();

  expect([table, human, ...others].flatMap((d) => d.errors)).toEqual([]);
});

test('iPad なし: スマホがテーブルを作って親機になり、最終結果まで進める', async ({ browser }) => {
  // 親機は人として、ホーム画面から作る
  const host = await open(browser, PHONE, '/');
  await host.page.getByRole('button', { name: 'iPad なしで、スマホだけで遊ぶ' }).click();
  await host.page.getByLabel('テーブルでの呼び名').fill('ゆき');
  await host.page.getByRole('button', { name: 'テーブルを作って参加する' }).click();
  await host.page.waitForURL(/\/play\/[A-Z2-9]{6}$/);
  const roomId = host.page.url().match(/\/play\/([A-Z2-9]{6})$/)![1]!;
  await expect(host.page.getByLabel('ルームコード')).toContainText(roomId);

  const names = ['はるか', 'そうた', 'みお'];
  const phones = await Promise.all(names.map((n) => bot(browser, roomId, n)));
  for (const n of names) await expect(host.page.locator('.hl-players')).toContainText(n);
  // 親機以外のスマホには、親機を待つ案内が出る
  await expect(phones[0]!.page.getByText('ゆき さんが対局を始めるのを待っています')).toBeVisible();
  await setGames(host.page, 1);
  await host.page.getByRole('button', { name: '4 人で対局を始める' }).click();

  // ここからは親機も自動で札を操作する（トークンは保存済みなので、同じ席に戻る）
  await host.page.goto(`/play/${roomId}?bot=1`);
  await expect(host.page.locator('.strip-row')).toHaveCount(3);
  await expect(host.page.getByRole('button', { name: /持ち時間を止める/ })).toBeVisible();
  await expect(phones[0]!.page.getByRole('button', { name: /持ち時間を止める/ })).toHaveCount(0);

  // 結果が出たら親機が進める（親機以外には進めるボタンが無い）
  const next = host.page.getByRole('button', { name: /次のゲームへ|最終結果を見る/ });
  await expect(next).toBeVisible({ timeout: 150_000 });
  await expect(phones[0]!.page.getByText('ゆき さんが次のゲームへ進めます')).toBeVisible();
  await expect(phones[0]!.page.locator('.strip-row')).toHaveCount(3);
  await next.click();

  for (const d of [host, ...phones]) await expect(d.page.locator('.final-mini li')).toHaveCount(4);
  expect([host, ...phones].flatMap((d) => d.errors)).toEqual([]);
});
