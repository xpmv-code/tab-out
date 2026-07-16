(() => {
  'use strict';

  const ALL_GROUP_ID = '__all__';

  const ICONS = Object.freeze({
    add: '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M12 5v14m7-7H5" /></svg>',
    edit: '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Z" /></svg>',
    remove: '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>',
  });

  function normalizeTagLabel(value) {
    return String(value || '').replace(/\s+/g, '').toLowerCase();
  }

  function renderGroupTabs(data, activeGroupId, { escapeAttr, escapeHtml }) {
    const counts = new Map(data.groups.map(group => [group.id, 0]));
    data.links.forEach(link => counts.set(link.groupId, (counts.get(link.groupId) || 0) + 1));
    const allActive = activeGroupId === ALL_GROUP_ID;
    const allTab = `
      <button class="quick-link-group-tab${allActive ? ' active' : ''}" type="button" data-action="select-quick-link-group" data-group-id="${ALL_GROUP_ID}" role="tab" aria-selected="${allActive}" aria-controls="quickLinksStrip">
        <span>全部</span>
        <span class="quick-link-group-count">${data.links.length}</span>
      </button>`;
    const groupTabs = data.groups.map(group => {
      const active = group.id === activeGroupId;
      return `
        <button class="quick-link-group-tab${active ? ' active' : ''}" type="button" data-action="select-quick-link-group" data-group-id="${escapeAttr(group.id)}" draggable="true" role="tab" aria-selected="${active}" aria-controls="quickLinksStrip" title="${escapeAttr(group.name)}，可拖拽排序">
          <span>${escapeHtml(group.name)}</span>
          <span class="quick-link-group-count">${counts.get(group.id) || 0}</span>
        </button>`;
    }).join('');
    const addTab = `
      <button class="quick-link-group-tab quick-link-group-add" data-action="show-quick-link-group-create" type="button" title="新建分组" aria-label="新建分组">
        ${ICONS.add}<span>新建</span>
      </button>`;
    return `${allTab}${groupTabs}${addTab}`;
  }

  function renderSuggestion(link, escapeAttr, escapeHtml) {
    if (link.suggestionStatus !== 'available' || !link.suggestedCategory) return '';
    const id = escapeAttr(link.id);
    return `
      <div class="favorite-suggestion" aria-label="分类建议">
        <span>建议归入“${escapeHtml(link.suggestedCategory)}”</span>
        <button type="button" data-action="accept-favorite-suggestion" data-link-id="${id}">归类</button>
        <button type="button" data-action="dismiss-favorite-suggestion" data-link-id="${id}" aria-label="忽略分类建议">忽略</button>
      </div>`;
  }

  function renderCard(link, utils) {
    const { escapeAttr, escapeHtml, getFaviconUrl, getInitial } = utils;
    const id = escapeAttr(link.id);
    const title = escapeHtml(link.title);
    const titleAttr = escapeAttr(link.title);
    const description = escapeHtml(link.description || '网站快捷入口');
    const url = escapeAttr(link.url);
    const groupId = escapeAttr(link.groupId);
    const categoryText = String(link.category || '常用').trim();
    const badgeText = String(link.badge || '').trim();
    const category = escapeHtml(categoryText);
    const badge = badgeText && normalizeTagLabel(badgeText) !== normalizeTagLabel(categoryText)
      ? `<span class="favorite-icon-badge">${escapeHtml(badgeText)}</span>`
      : '';
    const customFavicon = /^chrome-extension:\/\//i.test(link.favicon || '')
      ? link.favicon
      : '';
    const favicon = customFavicon || getFaviconUrl(link.url);
    const initial = escapeHtml(getInitial(link.title));

    return `
      <article class="quick-link-item favorite-card" data-link-id="${id}" data-group-id="${groupId}" data-favorite-color="${escapeAttr(link.color)}" draggable="true" role="listitem">
        <button class="favorite-card-open" type="button" data-action="open-quick-link" data-link-url="${url}" title="打开 ${titleAttr}" aria-label="打开 ${titleAttr}">
          <span class="favorite-card-head">
            <span class="favorite-icon-shell">
              <span class="quick-link-letter" aria-hidden="true">${initial}</span>
              ${favicon ? `<img class="quick-link-favicon" src="${escapeAttr(favicon)}" alt="">` : ''}
              ${badge}
            </span>
            <span class="favorite-identity">
              <span class="quick-link-label">${title}</span>
              <span class="favorite-description">${description}</span>
            </span>
          </span>
          <span class="favorite-card-footer">
            <span class="favorite-category">${category}</span>
          </span>
        </button>
        <span class="favorite-card-actions">
          <button class="favorite-card-action" type="button" data-action="edit-quick-link" data-link-id="${id}" title="编辑 ${titleAttr}" aria-label="编辑 ${titleAttr}">${ICONS.edit}</button>
          <button class="favorite-card-action quick-link-remove" type="button" data-action="remove-quick-link" data-link-id="${id}" title="删除 ${titleAttr}" aria-label="删除 ${titleAttr}">${ICONS.remove}</button>
        </span>
        ${renderSuggestion(link, escapeAttr, escapeHtml)}
      </article>`;
  }

  function renderAddCard() {
    return `
      <article class="quick-link-item favorite-card favorite-add-card" role="listitem">
        <button type="button" class="favorite-add-button" data-action="show-quick-link-form" aria-label="添加网站">
          <span class="favorite-add-icon">${ICONS.add}</span>
          <span class="favorite-add-title">添加常用网站</span>
        </button>
      </article>`;
  }

  function renderFavorites(data, activeGroupId, utils) {
    const links = activeGroupId === ALL_GROUP_ID
      ? data.links
      : data.links.filter(link => link.groupId === activeGroupId);
    return `${links.map(link => renderCard(link, utils)).join('')}${renderAddCard()}`;
  }

  function applyCardColors(container) {
    container?.querySelectorAll('[data-favorite-color]').forEach(card => {
      const color = globalThis.TabOutFavoritesMetadata?.sanitizeColor(card.dataset.favoriteColor);
      if (color) card.style.setProperty('--favorite-accent', color);
    });
  }

  globalThis.TabOutFavoritesRenderer = Object.freeze({
    ALL_GROUP_ID,
    applyCardColors,
    renderFavorites,
    renderGroupTabs,
  });
})();
