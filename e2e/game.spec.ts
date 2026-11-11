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

/** 長押しのボタンを押し続ける */
async function hold(page: Page, btn: ReturnType<Page['getByRole']>, ms = 900) {
  const box = (await btn.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(ms);
  await page.mouse.up();
}

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
  // 同じメンバーで次の対局: 待機中に戻り、全員がそのまま卓についている
  await table.page.getByRole('button', { name: '同じメンバーで次の対局' }).click();
  await expect(table.page.getByText('（2 対局目）')).toBeVisible();
  await expect(table.page.getByRole('button', { name: '4 人で対局を始める' })).toBeEnabled();
  expect([table, ...phones].flatMap((d) => d.errors)).toEqual([]);
});

test('2 人で遊べる: 伏せたランダムの場札 2 枚が場札公開でめくれ、最終結果まで進む', async ({ browser }) => {
  const table = await openTable(browser);
  const names = ['あかり', 'ひなた'];
  const phones = await Promise.all(names.map((n) => bot(browser, table.roomId, n)));
  for (const n of names) await expect(table.page.locator('body')).toContainText(n);
  await setGames(table.page, 2);
  await table.page.getByRole('button', { name: '2 人で対局を始める' }).click();
  // 配置中: 表の場札 1 枚と、伏せたランダムの場札 2 枚（ボットが出した札が加わるので 3 枚以上）
  await expect(table.page.locator('[data-phase="placement"]')).toBeVisible();
  expect(await table.page.locator('.board .board-slot .card').count()).toBeGreaterThanOrEqual(3);
  // 公開フェーズでは場札が 5 枚そろっている
  await expect(table.page.locator('[data-phase="reveal"]')).toBeVisible({ timeout: 60_000 });
  await expect(table.page.locator('.board .board-slot .card')).toHaveCount(5);
  const seen = await playToEnd(table.page, 2);
  for (const p of ['placement', 'boardReveal', 'reveal', 'result']) expect(seen, `通ったフェーズ: ${[...seen].join(', ')}`).toContain(p);
  await expect(table.page.locator('.final-list li')).toHaveCount(2);
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

  // 1 人では始められない（2 人から遊べる）
  await expect(table.page.getByRole('button', { name: 'あと 1 人で始められます' })).toBeDisabled();
  const others = [await bot(browser, table.roomId, 'はるか')];
  await expect(table.page.getByRole('button', { name: '2 人で対局を始める' })).toBeEnabled();
  others.push(await bot(browser, table.roomId, 'そうた'));
  await table.page.getByRole('button', { name: '3 人で対局を始める' }).click();

  // 前払いクレジット: 人は画面で 1 単位（100）を買う。テーブルには買った額が出る
  await expect(table.page.getByText('前払いクレジットを買っています')).toBeVisible();
  await expect(human.page.getByRole('heading', { name: '前払いクレジットを買う' })).toBeVisible();
  await human.page.getByRole('button', { name: '1 単位増やす' }).click();
  await hold(human.page, human.page.getByRole('button', { name: /長押しで 100 買う/ }));
  await expect(table.page.locator('.buy-list li', { hasText: 'ゆき' })).toContainText('100');
  await expect(table.page.locator('[data-phase="placement"]')).toBeVisible();
  await expect(human.page.locator('.paid-pill', { hasText: 'クレジット' })).toContainText('100');

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

test('スマホが裏に回って戻ると、つなぎ直して前のゲームの画面を残さない', async ({ browser }) => {
  const table = await openTable(browser);
  const others = await Promise.all(['はるか', 'そうた'].map((n) => bot(browser, table.roomId, n)));
  // 調べるスマホ: 接続を横取りして、「つながっているのに何も届かない」状態（iOS が裏で通信を止めた後）を作れるようにする
  const { defaultBrowserType: _, ...opts } = PHONE;
  const ctx = await browser.newContext(opts);
  opened.push(ctx);
  const phone = await ctx.newPage();
  const errors: string[] = [];
  phone.on('pageerror', (e) => errors.push(e.message));
  await phone.addInitScript(() => {
    const w = window as unknown as { __last?: WebSocket; __mute?: WebSocket; __hidden?: boolean };
    const Native = window.WebSocket;
    window.WebSocket = class extends Native {
      constructor(url: string | URL, p?: string | string[]) {
        super(url, p);
        w.__last = this;
      }
      set onmessage(h: ((ev: MessageEvent) => void) | null) {
        super.onmessage = h && ((ev: MessageEvent) => (w.__mute === this ? undefined : h.call(this, ev)));
      }
      get onmessage() {
        return super.onmessage;
      }
    } as typeof WebSocket;
    Object.defineProperty(document, 'visibilityState', { get: () => (w.__hidden ? 'hidden' : 'visible') });
  });
  await phone.goto(`/play/${table.roomId}?name=${encodeURIComponent('ゆき')}&bot=1`);
  await setGames(table.page, 2);
  await table.page.getByRole('button', { name: '3 人で対局を始める' }).click();

  // 1 ゲーム目の結果が出たところで裏に回る（届かなくなる）
  await expect(phone.locator('.ply-delta')).toBeVisible({ timeout: 150_000 });
  await phone.evaluate(() => {
    const w = window as unknown as { __last?: WebSocket; __mute?: WebSocket; __hidden?: boolean };
    w.__mute = w.__last;
    w.__hidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await table.page.getByRole('button', { name: '次のゲームへ' }).click();
  await expect(table.page.locator('[data-phase="placement"]')).toBeVisible();
  await phone.waitForTimeout(2_000);
  // 届いていないので、まだ前のゲームの結果の画面のまま
  await expect(phone.locator('.ply-delta')).toBeVisible();

  // 戻ってくると、つなぎ直して 2 ゲーム目の画面になる（前の結果は残らない）
  await phone.evaluate(() => {
    (window as unknown as { __hidden?: boolean }).__hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(phone.locator('.ply-delta')).toHaveCount(0);
  await expect(phone.locator('.stale-cover')).toHaveCount(0);
  await expect(phone.locator('.pg-main')).toBeVisible();
  expect([table, ...others].flatMap((d) => d.errors).concat(errors)).toEqual([]);
});
