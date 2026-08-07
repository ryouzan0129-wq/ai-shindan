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

const CACHE = 'apd-v7.8.0';

const PRECACHE = [
  './',
  './index.html',
  './style.css',
  './script.js',
  './themes.json',
  './questions.json',
  './real.json',
  './avatar.json',
  './assets/hair/short.png',
  './assets/hair/spiky.png',
  './assets/hair/sidepart.png',
  './assets/hair/long.png',
  './assets/hair/messycrop.png',
  './assets/hair/longwave.png',
  './assets/hair/messy.png',
  './assets/hair/bob.png',
  './assets/hair/ponytail.png',
  './assets/hair/curly.png',
  './assets/hair/curlyafro.png',
  './assets/hair/longstraight.png',
  './assets/hair/sidesweep.png',
  './assets/hair/wavylong.png',
  './assets/hair/braided.png',
  './assets/hair/sleekback.png',
  './assets/hair/sleekback2.png',
  './assets/hair/shortmessy.png',
  './assets/hair/longbangs.png',
  './assets/hair/wildspiky.png',
  './assets/hair/buzz.png',
  './assets/hair/shortside.png',
  './assets/hair/pompadour.png',
  './assets/hair/longside.png',
  './assets/bodies_bald/hero.png',
  './assets/bodies_bald/sage.png',
  './assets/bodies_bald/mage.png',
  './assets/bodies_bald/spellblade.png',
  './assets/bodies_bald/paladin.png',
  './assets/bodies_bald/assassin.png',
  './assets/bodies_bald/hunter.png',
  './assets/bodies_bald/merchant.png',
  './assets/bodies_bald/alchemist.png',
  './assets/bodies_bald/bard.png',
  './assets/bodies_bald/knight.png',
  './assets/bodies_bald/priest.png',
  './assets/bodies_bald/thief.png',
  './assets/bodies_bald/summoner.png',
  './assets/bodies_bald/swordmaster.png',
  './assets/bodies_bald/ninja.png',
  './assets/bodies_bald/astrologer.png',
  './assets/bodies_bald/beastmaster.png',
  './assets/bodies_bald/dragon.png',
  './assets/bodies_bald/phoenix.png',
  './assets/bodies_bald/goblin.png',
  './assets/bodies_bald/orc.png',
  './assets/bodies_bald/slime.png',
  './assets/bodies_bald/vampire.png',
  './assets/bodies_bald/angel.png',
  './assets/bodies_bald/demon.png',
  './assets/bodies_bald/fairy.png',
  './assets/bodies_bald/elf.png',
  './assets/bodies_bald/dwarf.png',
  './assets/bodies_bald/lizardman.png',
  './assets/bodies_bald/golem.png',
  './assets/bodies_bald/necromancer.png',
  './assets/bodies_bald/hero_female.png',
  './assets/bodies_bald/sage_female.png',
  './assets/bodies_bald/mage_female.png',
  './assets/bodies_bald/spellblade_female.png',
  './assets/bodies_bald/paladin_female.png',
  './assets/bodies_bald/assassin_female.png',
  './assets/bodies_bald/hunter_female.png',
  './assets/bodies_bald/merchant_female.png',
  './assets/bodies_bald/alchemist_female.png',
  './assets/bodies_bald/bard_female.png',
  './assets/bodies_bald/knight_female.png',
  './assets/bodies_bald/priest_female.png',
  './assets/bodies_bald/thief_female.png',
  './assets/bodies_bald/summoner_female.png',
  './assets/bodies_bald/swordmaster_female.png',
  './assets/bodies_bald/ninja_female.png',
  './assets/bodies_bald/astrologer_female.png',
  './assets/bodies_bald/beastmaster_female.png',
  './assets/bodies_bald/dragon_female.png',
  './assets/bodies_bald/phoenix_female.png',
  './assets/bodies_bald/goblin_female.png',
  './assets/bodies_bald/orc_female.png',
  './assets/bodies_bald/slime_female.png',
  './assets/bodies_bald/vampire_female.png',
  './assets/bodies_bald/angel_female.png',
  './assets/bodies_bald/demon_female.png',
  './assets/bodies_bald/fairy_female.png',
  './assets/bodies_bald/elf_female.png',
  './assets/bodies_bald/dwarf_female.png',
  './assets/bodies_bald/lizardman_female.png',
  './assets/bodies_bald/golem_female.png',
  './assets/bodies_bald/necromancer_female.png',
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
  './assets/bodies/hero_female.png',
  './assets/bodies/sage_female.png',
  './assets/bodies/mage_female.png',
  './assets/bodies/spellblade_female.png',
  './assets/bodies/paladin_female.png',
  './assets/bodies/assassin_female.png',
  './assets/bodies/hunter_female.png',
  './assets/bodies/merchant_female.png',
  './assets/bodies/alchemist_female.png',
  './assets/bodies/bard_female.png',
  './assets/bodies/knight_female.png',
  './assets/bodies/priest_female.png',
  './assets/bodies/thief_female.png',
  './assets/bodies/summoner_female.png',
  './assets/bodies/swordmaster_female.png',
  './assets/bodies/ninja_female.png',
  './assets/bodies/astrologer_female.png',
  './assets/bodies/beastmaster_female.png',
  './assets/bodies/dragon_female.png',
  './assets/bodies/phoenix_female.png',
  './assets/bodies/goblin_female.png',
  './assets/bodies/orc_female.png',
  './assets/bodies/slime_female.png',
  './assets/bodies/vampire_female.png',
  './assets/bodies/angel_female.png',
  './assets/bodies/demon_female.png',
  './assets/bodies/fairy_female.png',
  './assets/bodies/elf_female.png',
  './assets/bodies/dwarf_female.png',
  './assets/bodies/lizardman_female.png',
  './assets/bodies/golem_female.png',
  './assets/bodies/necromancer_female.png',
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
