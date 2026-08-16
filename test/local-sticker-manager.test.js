'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'local-sticker-manager.js'),
    'utf8'
);
const style = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'local-sticker-manager.css'),
    'utf8'
);

test('keeps common sticker management together and tool settings directly available', () => {
    assert.match(source, /\['packs', '贴纸集'\],[\s\S]*\['panel', '面板'\],[\s\S]*\['telegram', 'Telegram'\]/);
    assert.doesNotMatch(source, /\['stickers', '贴纸'\]|dataset\.pane = 'stickers'/);
    assert.match(source, /options\.openDirectory/);
    assert.match(source, /options\.chooseDirectory/);
    assert.match(source, /stickersPerRow/);
    assert.match(source, /panelWidth/);
    assert.match(source, /panelHeight/);
    assert.match(source, /createElement\('div', 'qlsm-layout-grid'\)/);
    assert.match(source, /createElement\('div', 'qlsm-recent-controls'\)/);
    assert.match(source, /sendAsImage/);
    assert.match(source, /directSendMode/);
    assert.match(source, /\['alt', 'Alt \+ 单击'\], \['click', '单击'\]/);
    assert.match(source, /recentEnabled/);
    assert.match(source, /recentRows/);
    assert.match(source, /createElement\('section', 'qlsm-tool-section'\)/);
    assert.match(source, /createElement\('h3', 'qlsm-tool-title', '转换工具'\)/);
    assert.match(source, /activeTab === 'telegram'[\s\S]*?inspectEnvironment\(\)/);
    assert.doesNotMatch(source, /createElement\('details'|advanced\.addEventListener\('toggle'/);
    assert.match(source, /addEventListener\('pointermove'/);
    assert.doesNotMatch(source, /draggable\s*=|dragstart/);
    for (const setting of [
        'telegramBotToken',
        'ffmpegPath',
        'tgsToGifPath'
    ]) {
        assert.match(source, new RegExp(setting));
    }
    assert.doesNotMatch(source, /httpProxy|options\.testProxy/);
    assert.match(source, /options\.inspectEnvironment/);
    assert.match(source, /options\.openToolDownload/);
    assert.match(source, /dataset\.downloadTool/);
    assert.match(source, /自动检测 PATH/);
    assert.doesNotMatch(source, /tgsToGifEnabled|启用 TGS 转 GIF/);
    assert.match(source, /options\.download/);
    assert.match(source, /options\.saveOrder/);
    assert.match(source, /在 Telegram 中通过 @BotFather 获取，仅保存在本地/);
    assert.doesNotMatch(source, /下载凭据/);
});

test('manages individual image and WebM stickers with confirmed deletion', () => {
    assert.match(source, /createElement\('div', 'qlsm-pack-group'\)/);
    assert.match(source, /createElement\('div', 'qlsm-pack-stickers'\)/);
    assert.match(source, /setPackExpanded\(group, pack, expanding\)/);
    assert.match(source, /dataset\.deletePack = 'true'/);
    assert.match(source, /options\.deletePack\?\.\(/);
    assert.match(source, /确定删除贴纸集/);
    assert.match(source, /createStickerMedia\(sticker\.path, 'qlsm-sticker-media'\)/);
    assert.match(source, /media\.defaultMuted = true/);
    assert.match(source, /createTrashIcon\(\)/);
    assert.match(source, /window\.confirm\(`确定从磁盘删除/);
    assert.match(source, /video\.pause\(\);[\s\S]*video\.removeAttribute\('src'\);[\s\S]*video\.load\(\)/);
    assert.match(source, /options\.deleteSticker\?\.\(sticker\.path\)/);
    assert.match(style, /\.qlsm-pack-stickers\s*\{[\s\S]*grid-template-columns:\s*repeat\(auto-fill, minmax\(68px, 1fr\)\)/);
    assert.match(style, /\.qlsm-pack-expand,/);
    assert.match(style, /\.qlsm-pack-delete\s*\{/);
    assert.match(style, /\.qlsm-sticker-delete\s*\{/);
});

test('keeps the sticker manager compact while its panes remain scrollable', () => {
    assert.match(style, /\.qlsm-page\s*\{[\s\S]*?width:\s*min\(560px,[\s\S]*?height:\s*min\(580px,/);
    assert.match(style, /\.qlsm-form\s*\{[\s\S]*?overflow-y:\s*auto/);
    assert.match(style, /\.qlsm-pack-list\s*\{[\s\S]*?overflow-y:\s*auto/);
    assert.match(style, /\.qlsm-layout-grid\s*\{[\s\S]*?grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\)/);
    assert.match(style, /\.qlsm-panel-form \.qlsm-config-row\s*\{[\s\S]*?min-height:\s*56px/);
    assert.match(style, /\.qlsm-tool-title\s*\{[\s\S]*?padding:\s*16px 0 8px;[\s\S]*?font-weight:\s*600/);
    assert.doesNotMatch(style, /\.qlsm-tool-body\s*\{[\s\S]*?border-top:/);
    assert.doesNotMatch(style, /\.qlsm-tool-section\s*\{[\s\S]*?border-bottom:/);
});
