// Display name and icon of each workspace item kind (shared/protocol.js KINDS). One place for every list, tab and badge.
export const KIND = {
  character: { label: '角色', type: '角色卡', icon: 'user' },
  lorebook: { label: '世界书', type: '世界书', icon: 'book' },
  regex: { label: '正则', type: '全局正则', icon: 'regex' },
  preset: { label: '预设', type: '预设', icon: 'sliders' }
};

/** @param {string} k */
export const kindOf = (k) => KIND[/** @type {keyof typeof KIND} */ (k)] || { label: k, type: k, icon: 'box' };

/** 资料库 kind switch. */
export const LIB_KINDS = [
  { value: 'character', label: '角色' },
  { value: 'lorebook', label: '世界书' },
  { value: 'regex', label: '正则' },
  { value: 'preset', label: '预设' }
];

/** 资料库 opened on one kind (`#/library/<kind>`); the route is the only way the kind changes. @param {string} [k] */
export const libraryHref = (k) => (k && k in KIND ? '#/library/' + k : '#/library');
