<script setup>
import { computed, onMounted, onBeforeUnmount } from 'vue';
import { useApp } from './stores/app.js';
import { useUi } from './stores/ui.js';
import { connectEvents } from './events.js';
import TitleBar from './components/TitleBar.vue';
import ActivityBar from './components/ActivityBar.vue';
import SidePanel from './components/SidePanel.vue';
import TabBar from './components/TabBar.vue';
import Inspector from './components/Inspector.vue';
import StatusBar from './components/StatusBar.vue';
import Toasts from './components/Toasts.vue';
import Wizard from './screens/Wizard.vue';
import Library from './screens/Library.vue';
import Settings from './screens/Settings.vue';
import ItemPage from './screens/ItemPage.vue';
import SyncPage from './screens/SyncPage.vue';
import HistoryPage from './screens/HistoryPage.vue';

const app = useApp();
const ui = useUi();

const showWizard = computed(() => app.ready && (ui.route.name === 'wizard' || !(app.settings && app.settings.ui && app.settings.ui.wizardDone)));
const screen = computed(() => ({ library: Library, settings: Settings, item: ItemPage, sync: SyncPage, history: HistoryPage }[ui.route.name] || Library));
const hasInspector = computed(() => ui.route.name === 'item' && !!app.item(ui.route.arg));

let statusTimer = 0;
const refreshSoon = () => { clearTimeout(statusTimer); statusTimer = window.setTimeout(() => app.refreshStatus(), 200); };

/** @type {null | (() => void)} */
let stopEvents = null;
let wasDown = false;
let loadTimer = 0;

async function load() {
  try {
    await app.loadAll();
  } catch (e) {
    app.online = false;
    clearTimeout(loadTimer);
    loadTimer = window.setTimeout(load, 2000);
  }
}

const onHash = () => ui.syncRoute();

onMounted(() => {
  window.addEventListener('hashchange', onHash);
  ui.syncRoute();
  load();
  stopEvents = connectEvents({
    onUp() {
      if (wasDown || !app.ready) { wasDown = false; load(); }
      else app.online = true;
    },
    onDown() { wasDown = true; app.online = false; },
    onStatus: refreshSoon,
    onTarget(d) {
      refreshSoon();
      // a tavern (dis)connecting changes detection results (running / connected pills)
      if (app.detect) app.refreshTaverns();
      if (d && d.connected === false && d.target) ui.toast(app.targetName(d.target) + ' 已断开', 'plug');
    }
  });
});
onBeforeUnmount(() => { window.removeEventListener('hashchange', onHash); if (stopEvents) stopEvents(); });
</script>

<template>
  <div v-if="!app.ready" class="boot">
    <div class="boot-mark brand-mark"><Icon name="wine" /></div>
  </div>

  <Wizard v-else-if="showWizard" />

  <div
    v-else
    class="app"
    :class="{
      'inspector-off': !hasInspector || !ui.inspector,
      'inspector-drawer': hasInspector && ui.inspectorDrawer,
      'side-off': !ui.side
    }"
  >
    <TitleBar />
    <div class="workbench">
      <ActivityBar />
      <SidePanel />
      <main class="main">
        <TabBar :has-inspector="hasInspector" />
        <div id="editor" class="editor">
          <component :is="screen" :key="ui.route.key" />
        </div>
      </main>
      <Inspector v-if="hasInspector" :path="ui.route.arg" />
    </div>
    <StatusBar />
  </div>

  <div v-if="app.ready && hasInspector && ui.inspectorDrawer" class="drawer-scrim insp-scrim" @click="ui.inspectorDrawer = false" />

  <div v-if="!app.online" class="offline-overlay" role="alertdialog" aria-live="assertive">
    <div class="offline-card">
      <Icon name="spin" size="lg" />
      <div>
        <b>无法连接 TavernCellar，正在重试…</b>
        <div class="faint">请确认伴侣程序仍在运行（127.0.0.1:{{ app.port }}）。</div>
      </div>
    </div>
  </div>

  <Toasts />
</template>

<script>
import Icon from './components/Icon.vue';
export default { components: { Icon } };
</script>
