import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  parseAttachmentDownload,
  parseAttachmentDrop,
  parseAttachmentPick,
  parseAttachmentSaved,
  parseDraftAttachment,
  parseDraftDelete,
  parseDraftDeleted,
  parseDraftOpened,
  parseDraftSave,
  parsePickedAttachments,
  sanitizeFileName
} from './mail-draft.ts';

const accountId = '00000000-0000-4000-8000-000000000001';

function saveRequest(): Record<string, unknown> {
  return {
    accountId,
    draftId: null,
    expectedMessageId: null,
    kind: 'new',
    threadId: null,
    messageId: null,
    to: ['bob@example.com'],
    cc: [],
    bcc: [],
    subject: 'Hello',
    body: 'Plain',
    attachmentTokens: [],
    replaceConfirmed: false,
    composerGeneration: 1
  };
}

describe('draft contracts', () => {
  it('rejects an extra field and a part id outside the grammar', () => {
    assert.notEqual(parseDraftSave(saveRequest()), null);
    assert.equal(parseDraftSave({ ...saveRequest(), raw: 'nope' }), null);
    assert.equal(
      parseAttachmentDownload({
        accountId,
        messageId: 'messageone',
        partId: '../1',
        attachmentId: null
      }),
      null
    );
    assert.equal(sanitizeFileName('../secret.txt').includes('/'), false);
    assert.equal(sanitizeFileName('a\r\nBcc: x').includes('\n'), false);
    assert.equal(sanitizeFileName('   '), 'Attachment');
    assert.equal(sanitizeFileName(`${'a'.repeat(250)}.txt`).length, 200);
  });

  it('accepts a complete draft and attachment contract and rejects a broken one', () => {
    const token = 'A'.repeat(32);
    const attachment = {
      token,
      fileName: 'notes.txt',
      mediaType: 'text/plain',
      size: 4
    };
    assert.deepEqual(parseDraftAttachment(attachment), attachment);
    assert.equal(parseDraftAttachment({ ...attachment, mediaType: 'not a type' }), null);
    assert.equal(parseDraftAttachment({ ...attachment, size: -1 }), null);
    assert.equal(parseDraftAttachment({ ...attachment, fileName: 'a\nb' }), null);
    assert.equal(parseDraftAttachment({ ...attachment, token: 'short' }), null);
    const opened = {
      locked: false,
      draftId: 'draftone',
      messageId: 'messageone',
      threadId: 'threadsame',
      kind: 'reply' as const,
      to: ['bob@example.com'],
      cc: [],
      bcc: [],
      subject: 'Re: Hello',
      body: 'Hi',
      subjectLocked: true,
      attachments: [attachment]
    };
    assert.equal(parseDraftOpened(opened)?.subjectLocked, true);
    assert.equal(
      parseDraftOpened({ ...opened, attachments: [{ ...attachment, size: 1.5 }] }),
      null
    );
    assert.equal(
      parseDraftSave({ ...saveRequest(), kind: 'reply', threadId: null, messageId: null }),
      null
    );
    assert.equal(
      parseDraftSave({
        ...saveRequest(),
        kind: 'reply',
        threadId: 'threadsame',
        messageId: 'messageone',
        subject: 'Re: Hello'
      })?.kind,
      'reply'
    );
    assert.equal(parseDraftSave({ ...saveRequest(), composerGeneration: 0 }), null);
    assert.equal(parseDraftSave({ ...saveRequest(), attachmentTokens: [token, token] }), null);
    assert.equal(parseDraftSave({ ...saveRequest(), subject: 'Hello\r\nBcc: x' }), null);
    assert.equal(
      parseDraftDelete({
        accountId,
        draftId: 'draftone',
        expectedMessageId: 'messageone'
      })?.draftId,
      'draftone'
    );
    assert.equal(parseDraftDelete({ accountId, draftId: 'draftone' }), null);
    assert.equal(parseDraftDeleted({ deleted: true })?.deleted, true);
    assert.equal(parseDraftDeleted({ deleted: false }), null);
    assert.equal(parseAttachmentPick({ accountId, composerGeneration: 1 })?.composerGeneration, 1);
    assert.equal(parseAttachmentPick({ accountId, composerGeneration: 0 }), null);
    assert.equal(parsePickedAttachments({ attachments: [attachment] })?.attachments.length, 1);
    assert.equal(parsePickedAttachments({ attachments: [{ ...attachment, token: 'no' }] }), null);
    assert.equal(parseAttachmentDrop({ accountId, composerGeneration: 1, token })?.token, token);
    assert.equal(parseAttachmentSaved({ saved: false })?.saved, false);
    assert.equal(parseAttachmentSaved({ saved: 'yes' }), null);
    assert.equal(
      parseAttachmentDownload({
        accountId,
        messageId: 'messageone',
        partId: null,
        attachmentId: 'attachone'
      })?.attachmentId,
      'attachone'
    );
    assert.equal(
      parseAttachmentDownload({
        accountId,
        messageId: 'messageone',
        partId: null,
        attachmentId: null
      }),
      null
    );
  });
});
