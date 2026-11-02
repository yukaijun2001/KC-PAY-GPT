'use strict';

// Presentation-only enhancement: business requests and permission checks remain in admin.html.
(() => {
    const sidebar = document.querySelector('.sidebar');
    const menuButton = document.getElementById('workspace_menu_toggle');
    const scrim = document.getElementById('sidebar_scrim');
    const breadcrumb = document.getElementById('workspace_page_name');
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let returnFocus;
    let currentPage = '';
    const visited = new Set();
    const navigation = sidebar?.querySelector('.nav-menu');
    const selection = document.createElement('span');
    selection.className = 'kc-nav-indicator';
    selection.setAttribute('aria-hidden', 'true');
    navigation?.appendChild(selection);

    function updateNavigation() {
        sidebar?.querySelectorAll('.nav-group-toggle').forEach(item => item.setAttribute('aria-expanded', String(item.closest('.nav-group').classList.contains('expanded'))));
        let active = navigation?.querySelector('.nav-item.active');
        if (active && !active.getClientRects().length) active = active.closest('.nav-group')?.querySelector('.nav-group-toggle');
        if (!active || !active.getClientRects().length) {
            navigation?.classList.remove('kc-nav-ready');
            return;
        }
        const base = navigation.getBoundingClientRect();
        const rect = active.getBoundingClientRect();
        selection.style.width = `${rect.width}px`;
        selection.style.height = `${rect.height}px`;
        selection.style.transform = `translate(${rect.left - base.left}px, ${rect.top - base.top}px)`;
        navigation.classList.add('kc-nav-ready');
    }

    const mobile = () => window.matchMedia('(max-width: 760px)').matches;
    function closeMenu(restoreFocus = false) {
        document.body.classList.remove('sidebar-open');
        menuButton?.setAttribute('aria-expanded', 'false');
        if (mobile()) sidebar?.setAttribute('inert', '');
        if (restoreFocus) returnFocus?.focus();
    }
    function openMenu() {
        returnFocus = document.activeElement;
        sidebar?.removeAttribute('inert');
        document.body.classList.add('sidebar-open');
        menuButton?.setAttribute('aria-expanded', 'true');
        requestAnimationFrame(() => {
            if (!document.body.classList.contains('sidebar-open')) return;
            (sidebar?.querySelector('.nav-item.active') || sidebar?.querySelector('.nav-item'))?.focus();
        });
    }
    function syncViewport() {
        if (!mobile()) { sidebar?.removeAttribute('inert'); closeMenu(); }
        else if (!document.body.classList.contains('sidebar-open')) sidebar?.setAttribute('inert', '');
        updateNavigation();
    }
    document.querySelectorAll('.nav-item').forEach(item => {
        item.tabIndex = 0;
        item.setAttribute('role', 'button');
        item.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); item.click(); }
        });
    });
    menuButton?.addEventListener('click', () => document.body.classList.contains('sidebar-open') ? closeMenu(true) : openMenu());
    scrim?.addEventListener('click', () => closeMenu(true));
    document.addEventListener('keydown', event => {
        if (!document.body.classList.contains('sidebar-open')) return;
        if (event.key === 'Escape') { closeMenu(true); return; }
        if (event.key !== 'Tab') return;
        const items = [...sidebar.querySelectorAll('.nav-item')].filter(el => el.getClientRects().length);
        if (!items.length) return;
        if (!items.includes(document.activeElement)) { event.preventDefault(); (event.shiftKey ? items.at(-1) : items[0]).focus(); }
        else if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1).focus(); }
        else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0].focus(); }
    });
    sidebar?.addEventListener('click', event => {
        const item = event.target.closest('.nav-item');
        if (item && !item.classList.contains('nav-group-toggle') && mobile()) closeMenu(true);
        requestAnimationFrame(updateNavigation);
    }, { capture: true });
    window.addEventListener('resize', syncViewport, { passive: true });
    syncViewport();

    function updatePage() {
        const page = document.querySelector('.page-view.active');
        if (!page || page.id === currentPage) return;
        currentPage = page.id;
        if (breadcrumb) breadcrumb.textContent = page.querySelector('.page-header h1')?.textContent || '控制台';
        if (!visited.has(page.id)) {
            visited.add(page.id);
            [...page.querySelectorAll(':scope > .panel, .stat-card')].slice(0, 12).forEach((item, index) => item.style.setProperty('--enter-delay', `${Math.min(index * 35, 175)}ms`));
            page.classList.add('kc-first-enter');
            setTimeout(() => page.classList.remove('kc-first-enter'), 750);
        }
        document.querySelectorAll('.nav-item').forEach(item => {
            if (item.classList.contains('active')) item.setAttribute('aria-current', 'page');
            else item.removeAttribute('aria-current');
        });
        updateNavigation();
    }
    const observer = new MutationObserver(updatePage);
    document.querySelectorAll('.page-view').forEach(page => observer.observe(page, { attributes: true, attributeFilter: ['class'] }));
    updatePage();

    // Highlight actual metric changes, never routine table refreshes or identical polling values.
    const metrics = new WeakMap();
    document.querySelectorAll('.stat-value').forEach(metric => {
        metrics.set(metric, metric.textContent);
        new MutationObserver(() => {
            const value = metric.textContent;
            if (value === metrics.get(metric)) return;
            metrics.set(metric, value);
            if (reducedMotion.matches || !metric.closest('.page-view.active')) return;
            metric.classList.remove('kc-value-update');
            requestAnimationFrame(() => metric.classList.add('kc-value-update'));
            setTimeout(() => metric.classList.remove('kc-value-update'), 400);
        }).observe(metric, { childList: true, characterData: true, subtree: true });
    });

    document.addEventListener('click', event => {
        const button = event.target.closest('.btn, .btn-delete');
        if (!button || button.disabled || reducedMotion.matches) return;
        const rect = button.getBoundingClientRect();
        const wave = document.createElement('span');
        wave.className = 'kc-click-wave';
        wave.style.left = `${event.clientX ? event.clientX - rect.left : rect.width / 2}px`;
        wave.style.top = `${event.clientY ? event.clientY - rect.top : rect.height / 2}px`;
        button.style.overflow = 'hidden';
        button.appendChild(wave);
        wave.addEventListener('animationend', () => wave.remove(), { once: true });
        setTimeout(() => wave.remove(), 650);
    });
})();
