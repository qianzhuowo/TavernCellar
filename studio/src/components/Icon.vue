<script setup>
// Icon by name, rendered with the prototype's svg.ic sizing classes.
import {
  Library, Folder, RefreshCw, History, Settings, User, BookOpen, Regex, SlidersHorizontal, Check, ArrowDown, ArrowUp,
  TriangleAlert, Minus, Circle, Plus, X, Search, ChevronDown, ChevronRight, ExternalLink, Copy, Info, Plug, Palette,
  Box, Sun, Moon, Wine, FolderOpen, Download, Upload, Trash2, Link, PanelRight, PanelLeft, LoaderCircle, Code, Terminal,
  CircleCheck, CircleAlert, WifiOff, HardDrive, Puzzle, ArrowLeft, ArrowRight, Hourglass
} from 'lucide-vue-next';

const MAP = {
  library: Library, folder: Folder, sync: RefreshCw, refresh: RefreshCw, history: History, settings: Settings,
  user: User, book: BookOpen, regex: Regex, sliders: SlidersHorizontal, check: Check, arrowDown: ArrowDown,
  arrowUp: ArrowUp, alert: TriangleAlert, minus: Minus, circle: Circle, plus: Plus, x: X, search: Search,
  chevDown: ChevronDown, chevRight: ChevronRight, external: ExternalLink, copy: Copy, info: Info, plug: Plug,
  palette: Palette, box: Box, sun: Sun, moon: Moon, wine: Wine, folderOpen: FolderOpen, download: Download,
  upload: Upload, trash: Trash2, link: Link, panelRight: PanelRight, panelLeft: PanelLeft, spin: LoaderCircle,
  code: Code, terminal: Terminal, ok: CircleCheck, err: CircleAlert, offline: WifiOff, disk: HardDrive,
  puzzle: Puzzle, back: ArrowLeft, next: ArrowRight, wait: Hourglass
};

defineProps({ name: { type: String, required: true }, size: { type: String, default: '' } });
</script>

<template>
  <svg v-if="name === 'dot'" class="ic" :class="size" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="5" fill="currentColor" stroke="none" /></svg>
  <component :is="MAP[name] || Circle" v-else class="ic" :class="[size, { spinning: name === 'spin' }]" aria-hidden="true" />
</template>
