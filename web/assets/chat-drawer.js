// File: web/assets/chat-drawer.js
// Purpose: Warm Room chat drawer — a slide-up panel for in-session messaging.
//          Extracted from session-ui.js to keep that module within project size limits.
// Role: Builds the chat drawer DOM node and manages open/close/unread state.
// Exports: window.sbChatDrawer.buildChatDrawer({ onSendChat, onUnreadChange })
//          → { node, open(), close(), toggle(), appendMsg(from, text), hasUnread() }
// Depends: DOM (createElement), theme.css (.sb-chat-drawer classes)
// Invariants: peer-supplied strings rendered via .textContent only (no innerHTML);
//             empty/whitespace send is suppressed; onSendChat called once per valid send;
//             unread flag clears on open.
// Last updated: Sprint 9 (2026-04-19) -- split into buildDrawerHeader/Form/MessageLog helpers

(function (root, factory) {
  'use strict';
  var mod = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = mod;
  }
  if (typeof window !== 'undefined') {
    window.sbChatDrawer = mod;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function el(tag, cls) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    return node;
  }

  // ---- Sub-builders (single responsibility each) ----

  function buildDrawerHeader(onClose) {
    var header = el('div', 'sb-chat-drawer-header');
    var title = el('h3', 'sb-chat-drawer-title');
    title.textContent = 'Chat';
    var closeBtn = el('button', 'sb-chat-drawer-close');
    closeBtn.type = 'button';
    closeBtn.textContent = '×';
    closeBtn.setAttribute('aria-label', 'Close chat');
    closeBtn.addEventListener('click', function () { onClose(); });
    header.append(title, closeBtn);
    return { node: header };
  }

  function buildDrawerForm(onSubmit) {
    var form = el('form', 'sb-chat-form');
    var input = el('input', 'sb-chat-input');
    input.type = 'text';
    input.maxLength = 500;
    input.placeholder = 'Message…';
    input.autocomplete = 'off';
    var sendBtn = el('button', 'sb-chat-send');
    sendBtn.type = 'submit';
    sendBtn.textContent = 'Send';
    form.append(input, sendBtn);
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var text = input.value.trim();
      if (!text) return;
      onSubmit(text);
      input.value = '';
    });
    return { node: form, input: input };
  }

  function buildMessageLog() {
    var log = el('ul', 'sb-chat-log');
    log.setAttribute('aria-live', 'polite');
    return {
      node: log,
      appendMsg: function (from, text) {
        var li = el('li', 'sb-chat-msg sb-chat-from-' + from);
        var label = el('span', 'sb-chat-label');
        label.textContent = from === 'teacher' ? 'Teacher' : 'Student';
        var body = el('span', 'sb-chat-body');
        body.textContent = text;
        li.append(label, document.createTextNode(': '), body);
        log.appendChild(li);
        log.scrollTop = log.scrollHeight;
      },
    };
  }

  // ---- Public assembler ----

  function buildChatDrawer(opts) {
    var onSendChat = opts.onSendChat || function () {};
    var onUnreadChange = opts.onUnreadChange || function () {};
    var _isOpen = false;
    var _hasUnread = false;

    var drawer = el('div', 'sb-chat-drawer');
    drawer.setAttribute('aria-label', 'Chat');
    drawer.hidden = true;

    function open() {
      _isOpen = true;
      drawer.hidden = false;
      if (_hasUnread) { _hasUnread = false; onUnreadChange(false); }
      formParts.input.focus();
    }

    function close() { _isOpen = false; drawer.hidden = true; }
    function toggle() { if (_isOpen) { close(); } else { open(); } }

    var header = buildDrawerHeader(function () { close(); });
    var msgLog = buildMessageLog();
    var formParts = buildDrawerForm(onSendChat);

    drawer.append(header.node, msgLog.node, formParts.node);

    return {
      node: drawer,
      open: open,
      close: close,
      toggle: toggle,
      appendMsg: function (from, text) {
        msgLog.appendMsg(from, text);
        if (!_isOpen) { _hasUnread = true; onUnreadChange(true); }
      },
      hasUnread: function () { return _hasUnread; },
    };
  }

  return { buildChatDrawer: buildChatDrawer };
});
