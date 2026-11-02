/* Visual behavior only; redemption and task requests remain in index.html. */
(() => {
    'use strict';
    const header = document.getElementById('landing_header');
    const menu = document.getElementById('landing_nav_dialog');
    const toggle = document.getElementById('landing_menu_toggle');
    if (!header || !menu || !toggle) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    let closePromise = null;

    const updateHeader = () => header.classList.toggle('is-scrolled', window.scrollY > 20);
    updateHeader();
    window.addEventListener('scroll', updateHeader, { passive: true });

    function openMenu() {
        if (menu.open || closePromise) return;
        menu.showModal();
        toggle.setAttribute('aria-expanded', 'true');
        menu.querySelector('[data-close-nav]').focus({ preventScroll: true });
    }

    function closeMenu() {
        if (closePromise) return closePromise;
        if (!menu.open) return Promise.resolve();
        const finish = () => {
            menu.close();
            menu.classList.remove('is-closing');
            toggle.setAttribute('aria-expanded', 'false');
            closePromise = null;
        };
        if (reduce.matches) {
            finish();
            return Promise.resolve();
        }
        menu.classList.add('is-closing');
        closePromise = Promise.all(menu.getAnimations().map(animation => animation.finished.catch(() => {})))
            .then(finish);
        return closePromise;
    }

    toggle.addEventListener('click', openMenu);
    menu.querySelector('[data-close-nav]').addEventListener('click', closeMenu);
    menu.addEventListener('cancel', event => {
        event.preventDefault();
        closeMenu();
    });
    menu.addEventListener('keydown', event => {
        if (event.key !== 'Tab') return;
        const controls = Array.from(menu.querySelectorAll('a[href], button:not(:disabled), [tabindex="0"]'))
            .filter(element => element.getClientRects().length > 0);
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
        }
    });
    menu.addEventListener('click', event => {
        if (event.target !== menu) return;
        const box = menu.getBoundingClientRect();
        if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) closeMenu();
    });
    menu.addEventListener('close', () => toggle.setAttribute('aria-expanded', 'false'));
    window.matchMedia('(min-width: 768px)').addEventListener('change', event => {
        if (event.matches && menu.open) closeMenu();
    });

    function moveTo(target, focusTarget) {
        if (!target) return;
        target.scrollIntoView({ behavior: reduce.matches ? 'auto' : 'smooth', block: 'start' });
        if (focusTarget) focusTarget.focus({ preventScroll: true });
    }

    document.querySelectorAll('a[data-open-plans], a[data-focus-recharge], a[href="#faq"]').forEach(link => {
        link.addEventListener('click', async event => {
            event.preventDefault();
            await closeMenu();
            if (link.hasAttribute('data-open-plans')) {
                const plans = document.getElementById('plans');
                plans.open = true;
                moveTo(plans, plans.querySelector('summary'));
            } else if (link.hasAttribute('data-focus-recharge')) {
                // Keep the selected business tab: a user may already be querying.
                const query = document.getElementById('querySection');
                const input = query.style.display !== 'none'
                    ? document.getElementById('queryInput')
                    : document.getElementById('step2').style.display !== 'none'
                        ? document.getElementById('tokenInput')
                        : document.getElementById('cdkInput');
                moveTo(document.getElementById('recharge'), input);
            } else {
                const faq = document.getElementById('faq');
                faq.open = true;
                moveTo(faq, faq.querySelector('summary'));
            }
        });
    });
    menu.querySelectorAll('a[href="/subscription"]').forEach(link => {
        link.addEventListener('click', async event => {
            event.preventDefault();
            await closeMenu();
            window.location.assign(link.href);
        });
    });

    // Reveal below-the-fold content once. The default HTML stays visible when
    // scripts or IntersectionObserver are unavailable.
    if ('IntersectionObserver' in window) {
        const observer = new IntersectionObserver(entries => {
            entries.forEach(entry => {
                if (!entry.isIntersecting) return;
                entry.target.classList.remove('reveal-pending');
                observer.unobserve(entry.target);
            });
        }, { threshold: .1 });
        document.querySelectorAll('[data-reveal]').forEach(element => {
            if (!reduce.matches && element.getBoundingClientRect().top >= window.innerHeight) {
                element.classList.add('reveal-pending');
                observer.observe(element);
            }
        });
        reduce.addEventListener('change', event => {
            if (!event.matches) return;
            document.querySelectorAll('.reveal-pending').forEach(element => element.classList.remove('reveal-pending'));
            observer.disconnect();
        });
    }

    // Animate visible form-state changes without replacing inputs or touching
    // their values, event handlers, or the underlying task state.
    const panels = ['step1', 'step2', 'querySection', 'taskProgress', 'statusMessage']
        .map(id => document.getElementById(id)).filter(Boolean);
    const visible = new Map(panels.map(panel => [panel, getComputedStyle(panel).display !== 'none']));
    const animations = new Map();
    const observer = new MutationObserver(records => {
        new Set(records.map(record => record.target)).forEach(panel => {
            const shown = getComputedStyle(panel).display !== 'none';
            if (shown && !visible.get(panel) && !reduce.matches) {
                animations.get(panel)?.cancel();
                const animation = panel.animate([
                    { opacity: 0, transform: 'translateY(6px)' },
                    { opacity: 1, transform: 'translateY(0)' }
                ], { duration: 200, easing: 'cubic-bezier(.16,1,.3,1)' });
                animation.finished.catch(() => {});
                animations.set(panel, animation);
            }
            visible.set(panel, shown);
        });
    });
    panels.forEach(panel => observer.observe(panel, { attributes: true, attributeFilter: ['style', 'class'] }));
    reduce.addEventListener('change', event => {
        if (event.matches) animations.forEach(animation => animation.cancel());
    });
    document.documentElement.dataset.rechargeUiReady = 'true';
})();
