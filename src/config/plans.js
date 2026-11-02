'use strict';

// Canonical local plan types and the corresponding OpenAI plan_name.
const PLAN_NAME_MAP = Object.freeze({
    go: 'chatgptgoplan',
    plus: 'chatgptplusplan',
    pro_10x: 'chatgptprolite',
    pro_20x: 'chatgptpro',
    pro_50x: 'chatgptpromax'
});

const PLAN_TYPE_LABELS = Object.freeze({
    go: 'ChatGPT Go',
    plus: 'ChatGPT Plus',
    pro_10x: 'ChatGPT Pro 10X',
    pro_20x: 'ChatGPT Pro 20X',
    pro_50x: 'ChatGPT Pro 50X'
});

function normalizePlanType(value) {
    const input = String(value || '').trim().toLowerCase() || 'plus';
    return Object.prototype.hasOwnProperty.call(PLAN_NAME_MAP, input) ? input : null;
}

function resolvePlanName(value) {
    const type = normalizePlanType(value);
    return type ? PLAN_NAME_MAP[type] : null;
}

function getPlanTypeLabel(value) {
    const type = normalizePlanType(value);
    return type ? PLAN_TYPE_LABELS[type] : `未知套餐 (${String(value || '').trim()})`;
}

module.exports = {
    PLAN_NAME_MAP,
    PLAN_TYPE_LABELS,
    normalizePlanType,
    resolvePlanName,
    getPlanTypeLabel
};
