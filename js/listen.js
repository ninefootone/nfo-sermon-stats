/**
 * Sermon Stats — listening time.
 *
 * Watches every <audio>/<video> on the page (including Plyr players and ones added later)
 * and reports how many seconds were actually played: when playback starts, every minute
 * while playing, and on pause, end or leaving the page. Skipping ahead doesn't count.
 * No cookies or storage: each play gets a random session code that only lives in this page.
 */
(function () {
	var cfg = window.nfoSermonListen;
	if (!cfg || !cfg.endpoint || !navigator.sendBeacon || !window.crypto || !window.WeakMap) return;

	var EXT = /\.(mp3|m4a|mp4|wav|aac|ogg|mov|m4v)$/i;
	var EVERY = 60; // seconds of playback between updates
	var state = new WeakMap();
	var playing = [];

	function randomId() {
		var a = new Uint8Array(12);
		crypto.getRandomValues(a);
		return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
	}

	// "/sermon-media/2026/10/Morning.player.mp3" or ".../wp-content/uploads/2026/10/Morning.mp3"
	// → "2026/10/Morning.mp3" (the same folder + filename the stats plugin matches titles on).
	function pathOf(el) {
		var src = el.currentSrc || el.src;
		if (!src) return '';
		var p;
		try { p = decodeURIComponent(new URL(src, location.href).pathname); } catch (e) { return ''; }
		p = p.replace(/^\/+/, '');
		var i = p.indexOf('wp-content/uploads/');
		if (i >= 0) p = p.slice(i + 19);
		p = p.replace(/^sermon-media\//, '').replace(/\.(player|download|podcast)(\.[a-z0-9]+)$/i, '$2');
		return EXT.test(p) ? p : '';
	}

	function stateFor(el) {
		var path = pathOf(el);
		if (!path) return null;
		var s = state.get(el);
		if (!s || s.path !== path) {
			s = { id: randomId(), path: path, secs: 0, last: null, sent: -1 };
			state.set(el, s);
		}
		return s;
	}

	function send(el, s) {
		var secs = Math.floor(s.secs);
		if (secs === s.sent) return;
		s.sent = secs;
		var d = isFinite(el.duration) ? Math.round(el.duration) : 0;
		try {
			navigator.sendBeacon(cfg.endpoint, JSON.stringify({ s: s.id, p: s.path, l: secs, d: d }));
		} catch (e) {}
	}

	function isMedia(el) {
		return el && (el.tagName === 'AUDIO' || el.tagName === 'VIDEO');
	}

	// Media events don't bubble, so listen in the capture phase on the whole document.
	document.addEventListener('play', function (e) {
		var el = e.target;
		if (!isMedia(el)) return;
		var s = stateFor(el);
		if (!s) return;
		s.last = el.currentTime;
		if (playing.indexOf(el) < 0) playing.push(el);
		if (s.sent < 0) send(el, s);
	}, true);

	document.addEventListener('timeupdate', function (e) {
		var el = e.target;
		var s = isMedia(el) && state.get(el);
		if (!s || el.paused) return;
		var t = el.currentTime;
		if (s.last !== null) {
			var step = t - s.last;
			if (step > 0 && step < 3) s.secs += step; // big jumps are skips, not listening
		}
		s.last = t;
		if (s.secs - Math.max(s.sent, 0) >= EVERY) send(el, s);
	}, true);

	document.addEventListener('seeked', function (e) {
		var s = isMedia(e.target) && state.get(e.target);
		if (s) s.last = e.target.currentTime;
	}, true);

	function stop(e) {
		var el = e.target;
		var s = isMedia(el) && state.get(el);
		if (!s) return;
		send(el, s);
		var i = playing.indexOf(el);
		if (i >= 0) playing.splice(i, 1);
	}
	document.addEventListener('pause', stop, true);
	document.addEventListener('ended', stop, true);

	function flushAll() {
		playing.forEach(function (el) {
			var s = state.get(el);
			if (s) send(el, s);
		});
	}
	window.addEventListener('pagehide', flushAll);
	document.addEventListener('visibilitychange', function () {
		if (document.visibilityState === 'hidden') flushAll();
	});
})();
