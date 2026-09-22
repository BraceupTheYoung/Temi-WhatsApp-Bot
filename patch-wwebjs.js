'use strict';
/**
 * patch-wwebjs.js — persistent postinstall patch for whatsapp-web.js@1.34.7.
 *
 * Why: node_modules edits vanish on `npm install` (incl. AWS deploys), so the
 * patch lives here and re-applies via the `postinstall` hook. Idempotent —
 * each entry carries its own marker and is skipped if already present; exits
 * 0 with a loud warning (never fails install) if expected source text isn't
 * found. Targets 1.34.x only.
 *
 * What (all in node_modules/whatsapp-web.js/src/util/Injected/Utils.js):
 *  1. upstream wwebjs#201923 (THE memoize fix): the WA Web build rolled out
 *     2026-09-17 gave the MediaData model an `id` attribute — spreading
 *     mediaOptions into the outgoing Msg copies its undefined `__x_id` over
 *     the real `id: newMsgKey`, and getValidatedSender() then throws
 *     "Data passed to getter must include an id property". One
 *     `delete message.__x_id` inside WWebJS.sendMessage fixes every media
 *     send; text sends carry no mediaOptions and are unaffected.
 *  2. validates prepRawMedia output BEFORE it reaches WA's memoized getters.
 *  3. labels the upload phase so any residual failure names the exact step.
 *
 * wwebjs injects this exact file into the page on every initialize, so
 * patching it IS patching the page context — no separate
 * evaluateOnNewDocument needed. Restart the bot after (re)applying.
 */
const fs = require('fs');
const path = require('path');

const TARGET = path.join(
    __dirname,
    'node_modules',
    'whatsapp-web.js',
    'src',
    'util',
    'Injected',
    'Utils.js',
);

const PATCHES = [
    {
        name: 'drop-__x_id (upstream wwebjs#201923)',
        marker: 'TEMI-PATCH-201923',
        oldText: `            ...botOptions,
            ...extraOptions,
        };

        // Bot's won't reply if canonicalUrl is set (linking)`,
        newText: `            ...botOptions,
            ...extraOptions,
        };

        // TEMI-PATCH-201923 (upstream wwebjs#201923): the WA Web build rolled
        // out 2026-09-17 gave the MediaData model an id attribute — spreading
        // mediaOptions above copies its undefined __x_id over the real
        // id: newMsgKey, and getValidatedSender() then throws "Data passed
        // to getter must include an id property". Drop it; text sends carry
        // no mediaOptions and are unaffected.
        delete message.__x_id;

        // Bot's won't reply if canonicalUrl is set (linking)`,
    },
    {
        name: 'validate-prep-before-storage-getter',
        marker: 'TEMI-PATCH-PREP',
        oldText: `        const mediaData = await mediaPrep.waitForPrep();
        const mediaObject = window
            .require('WAWebMediaStorage')
            .getOrCreateMediaObject(mediaData.filehash);`,
        newText: `        const mediaData = await mediaPrep.waitForPrep();
        // TEMI-PATCH-PREP: validate prep output BEFORE passing anything into
        // WA's memoized getters — getOrCreateMediaObject(undefined) throws
        // "Data passed to getter must include an id property".
        if (!mediaData) {
            throw new Error('media-fault: prepRawMedia returned empty');
        }
        if (!mediaData.filehash) {
            throw new Error('media-fault: sendToChat filehash undefined');
        }
        const mediaObject = window
            .require('WAWebMediaStorage')
            .getOrCreateMediaObject(mediaData.filehash);
        if (!mediaObject) {
            throw new Error('media-fault: getOrCreateMediaObject returned empty');
        }`,
    },
    {
        name: 'label-upload-step',
        marker: 'TEMI-PATCH-UPLOAD',
        oldText: `        const uploadedMedia = !sendToChannel
            ? await uploadMedia(dataToUpload)
            : await uploadUnencryptedMedia(dataToUpload);`,
        newText: `        // TEMI-PATCH-UPLOAD: label the upload step so failures name the phase.
        let uploadedMedia;
        try {
            uploadedMedia = !sendToChannel
                ? await uploadMedia(dataToUpload)
                : await uploadUnencryptedMedia(dataToUpload);
        } catch (uploadErr) {
            throw new Error(
                'media-fault: upload step failed: ' +
                    (uploadErr?.message || uploadErr),
            );
        }`,
    },
];

const fail = (msg) => {
    console.error(`[patch-wwebjs] WARNING: ${msg}`);
};

const main = () => {
    let installed = 'unknown';
    try {
        installed = require('whatsapp-web.js/package.json').version;
    } catch {}
    if (!/^1\.34\./.test(installed)) {
        console.log(`[patch-wwebjs] skipping — targets 1.34.x, installed is ${installed}.`);
        return;
    }
    if (!fs.existsSync(TARGET)) {
        fail(`target not found at ${TARGET} — running UNPATCHED.`);
        return;
    }
    let src = fs.readFileSync(TARGET, 'utf8');
    let applied = 0;
    let skipped = 0;
    for (const p of PATCHES) {
        if (src.includes(p.marker)) {
            skipped++;
            continue;
        }
        const hits = src.split(p.oldText).length - 1;
        if (hits !== 1) {
            fail(`patch "${p.name}" expected 1 match, found ${hits} — leaving it out (rest still apply).`);
            continue;
        }
        src = src.replace(p.oldText, p.newText);
        applied++;
    }
    if (applied > 0) {
        fs.writeFileSync(TARGET, src);
    }
    console.log(`[patch-wwebjs] applied=${applied} already-present=${skipped}.`);
};

main();
