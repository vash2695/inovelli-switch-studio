const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const templatePath = path.resolve(__dirname, '../../switch_studio/templates/index.html');
const template = fs.readFileSync(templatePath, 'utf8');

test('dashboard shell keeps only main-view branding and the useful device summary', () => {
    assert.match(template, /<div class="header-brand">[\s\S]*?<h1 class="studio-title">Switch Studio<\/h1>/);
    assert.match(template, /body\.dashboard-active \.header-brand\s*\{\s*display:\s*flex;\s*\}/);
    assert.match(template, /body\.dashboard-active \.header-controls\s*\{\s*display:\s*none;\s*\}/);
    assert.match(template, /class="dashboard-summary-row"/);
    assert.doesNotMatch(template, /Your switches, at a glance/);
    assert.doesNotMatch(template, /class="dashboard-description"/);
});

test('device-only header controls stay available without redundant status actions', () => {
    assert.match(template, /<select id="deviceSelect"/);
    assert.match(template, /grid-template-areas:\s*"device"\s*"quick";/);
    assert.doesNotMatch(template, /id="connectionChip"/);
    assert.doesNotMatch(template, /id="connectionText"/);
    assert.doesNotMatch(template, /id="btnForceSync"/);
    assert.doesNotMatch(template, /Quick control confirmed/);
});

test('device header percentage input is locked to a three-digit control width', () => {
    const rule = template.match(/input\.quick-brightness-input\s*\{([\s\S]*?)\}/);
    assert.ok(rule, 'quick brightness input rule should exist');
    assert.match(rule[1], /width:\s*50px;/);
    assert.match(rule[1], /min-width:\s*50px;/);
    assert.match(rule[1], /max-width:\s*50px;/);
    assert.match(rule[1], /flex:\s*0 0 50px;/);
    assert.match(rule[1], /font-variant-numeric:\s*tabular-nums;/);
});
