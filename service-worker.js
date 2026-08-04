/* =====================================================================
 * AI超精密性格診断 — service-worker.js
 * 方針：
 *  - インストール時に全静的アセットをprecache（JSON含む＝完全オフライン動作）
 *  - cache-first（ヒットしなければネットワーク→取得できたらキャッシュに追加）
 *  - ナビゲーションは常に index.html（SPA・オフライン起動対応）
 *  - 更新は CACHE のバージョン名を上げるだけ（旧キャッシュは activate で削除）
 * すべて相対パス：GitHub Pages のサブディレクトリ配信でも動作する
 * ===================================================================== */

'use strict';

const CACHE = 'apd-v7.1.0';

const PRECACHE = [
  './',
  './index.html',
  './style.css',
  './script.js',
  './themes.json',
  './questions.json',
  './real.json',
  './avatar.json',
  './assets/bodies/hero.png',
  './assets/bodies/sage.png',
  './assets/bodies/mage.png',
  './assets/bodies/spellblade.png',
  './assets/bodies/paladin.png',
  './assets/bodies/assassin.png',
  './assets/bodies/hunter.png',
  './assets/bodies/merchant.png',
  './assets/bodies/alchemist.png',
  './assets/bodies/bard.png',
  './assets/bodies/knight.png',
  './assets/bodies/priest.png',
  './assets/bodies/thief.png',
  './assets/bodies/summoner.png',
  './assets/bodies/swordmaster.png',
  './assets/bodies/ninja.png',
  './assets/bodies/astrologer.png',
  './assets/bodies/beastmaster.png',
  './assets/bodies/dragon.png',
  './assets/bodies/phoenix.png',
  './assets/bodies/goblin.png',
  './assets/bodies/orc.png',
  './assets/bodies/slime.png',
  './assets/bodies/vampire.png',
  './assets/bodies/angel.png',
  './assets/bodies/demon.png',
  './assets/bodies/fairy.png',
  './assets/bodies/elf.png',
  './assets/bodies/dwarf.png',
  './assets/bodies/lizardman.png',
  './assets/bodies/golem.png',
  './assets/bodies/necromancer.png',
  './manifest.json',
  './assets/icons/icon.svg',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/icon-maskable-512.png',
];

/* インストール：precache して即時有効化 */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => Promise.allSettled(PRECACHE.map((u) => cache.add(u))))
      .then(() => self.skipWaiting())
  );
});

/* 有効化：旧バージョンのキャッシュを削除して制御を奪取 */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

/* フェッチ：cache-first。ナビゲーションのオフラインフォールバックは index.html */
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  // ページ遷移（アドレスバー入力・ホーム画面起動など）
  if (req.mode === 'navigate') {
    event.respondWith(
      caches.match('./index.html')
        .then((hit) => hit ?? fetch(req))
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        // 同一オリジンの正常応答のみ動的キャッシュ（外部シェアURL等は対象外）
        if (res.ok && new URL(req.url).origin === self.location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
        }
        return res;
      });
    })
  );
});
