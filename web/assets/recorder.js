// File: web/assets/recorder.js
// Purpose: Client-side recording capture using MediaRecorder + Web Audio API.
//          Composites teacher mic + student remote audio; records teacher video.
// Exports: window.sbRecorder.{start, uploadRecording}
// Depends: MediaRecorder, AudioContext, WebSocket (via signalling.js for upload)
// Invariants: Recording only starts when MediaRecorder.start() is called.
//             MIME type falls back: video/webm;codecs=vp8,opus → video/webm → audio/webm;codecs=opus.
//             uploadRecording sends the blob to /api/recordings/upload.
//             Chunks accumulated in order; assembled into a single Blob on stop.
// Last updated: Sprint 6 (2026-04-18) -- initial implementation

'use strict';

(function (root) {

  var MIME_PREFERENCES = [
    'video/webm;codecs=vp8,opus',
    'video/webm',
    'audio/webm;codecs=opus',
    'audio/webm',
  ];

  function chooseMime() {
    for (var i = 0; i < MIME_PREFERENCES.length; i++) {
      if (MediaRecorder.isTypeSupported(MIME_PREFERENCES[i])) {
        return MIME_PREFERENCES[i];
      }
    }
    return '';
  }

  /**
   * Start a recording session.
   *
   * @param {Object} opts
   * @param {MediaStream} opts.localStream  - teacher mic + video stream
   * @param {MediaStream} opts.remoteStream - student audio stream
   * @returns {Object} handle with .stop() method that returns a Promise<Blob>
   */
  function start(opts) {
    var localStream = opts.localStream;
    var remoteStream = opts.remoteStream;

    var ctx = new (window.AudioContext || window.webkitAudioContext)();
    var dest = ctx.createMediaStreamDestination();

    // Mix teacher mic into composite.
    if (localStream) {
      var localSource = ctx.createMediaStreamSource(localStream);
      localSource.connect(dest);
    }
    // Mix student audio into composite.
    if (remoteStream) {
      var remoteSource = ctx.createMediaStreamSource(remoteStream);
      remoteSource.connect(dest);
    }

    // Build the composite stream: mixed audio + teacher video.
    var tracks = [];
    dest.stream.getAudioTracks().forEach(function (t) { tracks.push(t); });
    if (localStream) {
      localStream.getVideoTracks().forEach(function (t) { tracks.push(t); });
    }
    var composite = new MediaStream(tracks);

    var mime = chooseMime();
    var options = mime ? { mimeType: mime } : {};
    var recorder = new MediaRecorder(composite, options);
    var chunks = [];

    recorder.addEventListener('dataavailable', function (e) {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    });

    recorder.start(1000); // collect every 1s

    var stopPromise = new Promise(function (resolve) {
      recorder.addEventListener('stop', function () {
        ctx.close().catch(function () {});
        var blob = new Blob(chunks, { type: recorder.mimeType || 'video/webm' });
        resolve(blob);
      });
    });

    return {
      stop: function () {
        if (recorder.state !== 'inactive') recorder.stop();
        return stopPromise;
      },
    };
  }

  /**
   * Upload a recording blob to the server.
   *
   * @param {Object} opts
   * @param {Blob}   opts.blob
   * @param {string} opts.studentEmail
   * @param {number} [opts.durationS]
   * @returns {Promise<{id: number, token: string}>}
   */
  function uploadRecording(opts) {
    var blob = opts.blob;
    var studentEmail = opts.studentEmail;
    var durationS = opts.durationS;

    var url = '/api/recordings/upload?student_email=' + encodeURIComponent(studentEmail);
    if (durationS != null) url += '&duration_s=' + Math.round(durationS);

    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': blob.type || 'video/webm' },
      body: blob,
    }).then(function (r) {
      if (!r.ok) throw new Error('upload failed: ' + r.status);
      return r.json();
    });
  }

  root.sbRecorder = { start: start, uploadRecording: uploadRecording };

}(window));
