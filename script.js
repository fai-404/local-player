"use strict";
/* ---------- storage ---------- */
const store = {
  get(k, d){ try{ const v = localStorage.getItem('mmp.'+k); return v !== null ? JSON.parse(v) : d; }catch(e){ return d; } },
  set(k, v){ try{ localStorage.setItem('mmp.'+k, JSON.stringify(v)); }catch(e){} },
  del(k){ try{ localStorage.removeItem('mmp.'+k); }catch(e){} }
};
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const $ = id => document.getElementById(id);
const fmt = s => { s = Math.max(0, Math.floor(s || 0)); return Math.floor(s/60) + ':' + String(s%60).padStart(2,'0'); };

/* ---------- state ---------- */
let token   = store.get('token', '');
let library = store.get('library', []);     // [{fileId,title,artist,duration,filePath}]
let playlists = store.get('playlists', []); // [{id,name,songIds:[]}]
let recent  = store.get('recent', []);      // [fileId,...]
let liked   = store.get('liked', []);       // [fileId,...]
let queue = [], qi = -1;
let shuffle = false, repeatMode = 'off';    // off | all | one
let currentTab = 'home', currentPlId = null, pickerSongId = null;
const audio = $('audio');

/* ---------- telegram api ---------- */
async function tg(method, params){
  const q = new URLSearchParams(params || {}).toString();
  const url = 'https://api.telegram.org/bot' + token + '/' + method + (q ? '?' + q : '');
  let res;
  try{ res = await fetch(url); }
  catch(e){ throw new Error('Network error — check your connection.'); }
  let j;
  try{ j = await res.json(); }
  catch(e){ throw new Error('Bad response from Telegram.'); }
  if(!j.ok) throw new Error(j.description || 'Telegram error');
  return j.result;
}

async function syncLibrary(silent){
  const btn = $('syncBtn');
  if(!silent && btn){ btn.classList.add('syncing'); btn.innerHTML = '<span class="spinner"></span>syncing'; btn.disabled = true; }
  try{
    await tg('getMe'); // validates token
    let offset = store.get('offset', 0);
    const seen = new Set(library.map(s => s.fileId));
    let added = 0, guard = 0;
    for(;;){
      if(++guard > 50) break; // safety cap: 5000 updates
      const updates = await tg('getUpdates', {offset: offset, limit: 100, timeout: 0});
      if(!updates.length) break;
      for(const u of updates){
        if(u.update_id >= offset) offset = u.update_id + 1;
        const m = u.message || u.channel_post;
        if(!m) continue;
        const a = m.audio, d = m.document;
        let fileId = null, title = '', artist = 'Unknown', duration = 0, fileName = '';
        if(a){
          fileId = a.file_id; title = a.title || ''; artist = a.performer || 'Unknown';
          duration = a.duration || 0; fileName = a.file_name || '';
        }else if(d && d.mime_type && d.mime_type.indexOf('audio/') === 0){
          fileId = d.file_id; fileName = d.file_name || '';
        }
        if(!fileId || seen.has(fileId)) continue;
        seen.add(fileId);
        if(!title) title = (fileName.replace(/\.[^.]+$/, '') || 'Unknown track');
        library.push({fileId: fileId, title: title, artist: artist, duration: duration, filePath: null});
        added++;
      }
      store.set('offset', offset);
    }
    store.set('offset', offset);
    store.set('library', library);
    renderAll();
    toast(added ? ('Synced — ' + added + ' new song' + (added === 1 ? '' : 's')) : 'Already up to date');
  }catch(e){
    toast('Sync failed: ' + e.message);
  }finally{
    if(!silent && btn){ btn.classList.remove('syncing'); btn.textContent = 'Sync'; btn.disabled = false; }
  }
}

async function streamUrl(song){
  if(song.filePath) return 'https://api.telegram.org/file/bot' + token + '/' + song.filePath;
  const f = await tg('getFile', {file_id: song.fileId});
  if(f.file_size && f.file_size > 20 * 1024 * 1024)
    throw new Error('File is over 20 MB — the bot API cannot stream it.');
  song.filePath = f.file_path;
  store.set('library', library);
  return 'https://api.telegram.org/file/bot' + token + '/' + f.file_path;
}

/* ---------- toast ---------- */
let toastTimer = null;
function toast(msg){
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

/* ---------- rendering ---------- */
function songRow(s, idx, opts){
  opts = opts || {};
  const playing = queue[qi] && queue[qi].fileId === s.fileId;
  const isLiked = liked.indexOf(s.fileId) !== -1;
  const inner =
    '<div class="mbox"><span>♪</span></div>' +
    '<div class="meta"><div class="t">' + esc(s.title) + '</div>' +
    '<div class="a">' + esc(s.artist) + '</div></div>' +
    (opts.remove
      ? '<button class="rmbtn" data-rm="' + esc(s.fileId) + '" title="Remove">✕</button>'
      : '<button class="likebtn' + (isLiked ? ' on' : '') + '" data-like="' + esc(s.fileId) + '" title="Like">♥</button>');
  if(opts.remove){
    return '<div class="song' + (playing ? ' playing' : '') + '" data-play="' + idx + '">' + inner + '</div>';
  }
  return '<div class="swipewrap">' +
    '<div class="swipeactions">' +
      '<button class="swact" data-queue="' + esc(s.fileId) + '"><span class="ic">☰</span><span class="lb">Queue</span></button>' +
      '<button class="swact" data-pladd="' + esc(s.fileId) + '"><span class="ic">+</span><span class="lb">Playlist</span></button>' +
    '</div>' +
    '<div class="song' + (playing ? ' playing' : '') + '" data-play="' + idx + '">' + inner + '</div>' +
    '</div>';
}

function currentSongList(){
  const q = $('search').value.trim().toLowerCase();
  const match = s => !q || (s.title + ' ' + s.artist).toLowerCase().indexOf(q) !== -1;
  const map = new Map(library.map(s => [s.fileId, s]));
  if(currentTab === 'home') return recent.map(id => map.get(id)).filter(Boolean).filter(match);
  if(currentTab === 'liked') return liked.map(id => map.get(id)).filter(Boolean).filter(match);
  if(currentTab === 'playlists'){
    if(!currentPlId) return [];
    const pl = playlists.find(p => p.id === currentPlId);
    if(!pl) return [];
    return pl.songIds.map(id => map.get(id)).filter(Boolean).filter(match);
  }
  return library.filter(match);
}

function renderHome(){
  const el = $('homeTab');
  if(currentTab !== 'home'){ el.innerHTML = ''; return; }
  const list = currentSongList();
  let html = '<div class="homehead">Stay in loop</div>';
  if(!library.length){
    html += '<div class="empty">No songs yet.<br>Send audio files to your bot, then tap <b>Sync</b> above.</div>';
  }else if(!list.length){
    html += '<div class="empty">Nothing played yet.</div>';
  }else{
    html += list.map((s, i) => songRow(s, i)).join('');
  }
  el.innerHTML = html;
  bindAllSwipes(el);
}

function renderLibrary(){
  const el = $('libraryTab');
  if(currentTab !== 'library'){ el.innerHTML = ''; return; }
  const list = currentSongList();
  if(!library.length){
    el.innerHTML = '<div class="empty">No songs yet.<br>Send audio files to your bot, then tap <b>Sync</b> above.</div>';
    return;
  }
  if(!list.length){ el.innerHTML = '<div class="empty">No matches.</div>'; return; }
  el.innerHTML = list.map((s, i) => songRow(s, i)).join('');
  bindAllSwipes(el);
}

function renderLiked(){
  const el = $('likedTab');
  if(currentTab !== 'liked'){ el.innerHTML = ''; return; }
  const list = currentSongList();
  if(!list.length){ el.innerHTML = '<div class="empty">No liked songs yet.<br>Tap ♥ on any song.</div>'; return; }
  el.innerHTML = list.map((s, i) => songRow(s, i)).join('');
  bindAllSwipes(el);
}

function renderPlaylists(){
  const el = $('playlistsTab');
  if(currentTab !== 'playlists'){ el.innerHTML = ''; return; }
  if(!playlists.length){
    el.innerHTML = '<div class="empty">No playlists yet.<br>Swipe a song left and tap + to add it to a new playlist.</div>';
    return;
  }
  el.innerHTML = playlists.map(p =>
    '<div class="plrow" data-openpl="' + esc(p.id) + '">' +
    '<div class="mbox"><span>♪</span></div><div class="meta"><div class="t">' + esc(p.name) + '</div>' +
    '<div class="a">' + p.songIds.length + ' songs</div></div>' +
    '<button class="rmbtn" data-delpl="' + esc(p.id) + '" title="Delete">✕</button></div>'
  ).join('');
}

function renderAll(){ renderHome(); renderLibrary(); renderLiked(); renderPlaylists(); }

function switchTab(name){
  currentTab = name; currentPlId = null;
  closeAllSwipes();
  $('tabHome').classList.toggle('active', name === 'home');
  $('tabLibrary').classList.toggle('active', name === 'library');
  $('tabLiked').classList.toggle('active', name === 'liked');
  $('tabPlaylists').classList.toggle('active', name === 'playlists');
  $('homeTab').hidden = name !== 'home';
  $('libraryTab').hidden = name !== 'library';
  $('likedTab').hidden = name !== 'liked';
  $('playlistsTab').hidden = name !== 'playlists';
  renderAll();
}

/* ---------- swipe rows ---------- */
let openSwipe = null;
function closeSwipe(wrap){
  const inner = wrap.querySelector('.song');
  if(inner) inner.style.transform = '';
  if(openSwipe === wrap) openSwipe = null;
}
function closeAllSwipes(){
  document.querySelectorAll('.swipewrap').forEach(closeSwipe);
  openSwipe = null;
}
function bindAllSwipes(container){
  container.querySelectorAll('.swipewrap').forEach(wrap => {
    if(wrap.getAttribute('data-bound')) return;
    wrap.setAttribute('data-bound', '1');
    const inner = wrap.querySelector('.song');
    let sx = 0, dx = 0, dragging = false;
    inner.addEventListener('touchstart', e => {
      if(openSwipe && openSwipe !== wrap) closeSwipe(openSwipe);
      sx = e.touches[0].clientX; dx = 0; dragging = true;
    }, {passive: true});
    inner.addEventListener('touchmove', e => {
      if(!dragging) return;
      dx = e.touches[0].clientX - sx;
      if(dx > 0) dx = 0;
      if(dx < -160) dx = -160;
      inner.style.transition = 'none';
      inner.style.transform = 'translateX(' + dx + 'px)';
    }, {passive: true});
    inner.addEventListener('touchend', () => {
      dragging = false;
      inner.style.transition = '';
      if(dx < -60){ inner.style.transform = 'translateX(-152px)'; openSwipe = wrap; }
      else { inner.style.transform = ''; if(openSwipe === wrap) openSwipe = null; }
      dx = 0;
    });
  });
}

/* ---------- player ---------- */
function setPlayIcon(){
  const ic = audio.paused ? '▶' : '❚❚';
  $('mpToggle').textContent = ic; $('btnPlay').textContent = ic;
}

function updateMediaSession(song){
  if(!('mediaSession' in navigator)) return;
  try{
    navigator.mediaSession.metadata = new MediaMetadata({
      title: song.title, artist: song.artist, album: 'Ente Casette'
    });
    navigator.mediaSession.setActionHandler('play', () => audio.play());
    navigator.mediaSession.setActionHandler('pause', () => audio.pause());
    navigator.mediaSession.setActionHandler('previoustrack', playPrev);
    navigator.mediaSession.setActionHandler('nexttrack', playNext);
  }catch(e){}
}

function showMini(song){
  $('miniPlayer').hidden = false;
  $('mpTitle').textContent = song.title;
  $('mpArtist').textContent = song.artist;
  document.body.style.paddingBottom = '110px';
}

function openPlayer(){
  const fp = $('fullPlayer');
  if(!fp.hidden && fp.classList.contains('open')) return;
  fp.hidden = false;
  requestAnimationFrame(() => requestAnimationFrame(() => fp.classList.add('open')));
}
function closePlayer(){
  const fp = $('fullPlayer');
  if(fp.hidden) return;
  fp.classList.remove('open');
  setTimeout(() => { fp.hidden = true; }, 330);
}

async function playFromList(listIndex, openUI){
  const list = currentSongList();
  if(!list.length) return;
  queue = list.slice();
  if(shuffle){
    const first = queue.splice(listIndex, 1)[0];
    for(let i = queue.length - 1; i > 0; i--){
      const j = Math.floor(Math.random() * (i + 1));
      const t = queue[i]; queue[i] = queue[j]; queue[j] = t;
    }
    queue.unshift(first); qi = 0;
  }else{
    qi = listIndex;
  }
  await playCurrent(openUI);
}

async function playCurrent(openUI){
  const song = queue[qi];
  if(!song) return;
  showMini(song);
  $('fpTitle').textContent = song.title;
  $('fpArtist').textContent = song.artist;
  if(openUI) openPlayer();
  setPlayIcon();
  $('btnPlay').innerHTML = '<span class="spinner"></span>';
  try{
    audio.src = await streamUrl(song);
    await audio.play();
  }catch(e){
    toast('Playback failed: ' + e.message);
  }
  pushRecent(song);
  updateMediaSession(song);
  renderAll();
  setPlayIcon();
}

function pushRecent(song){
  recent = [song.fileId].concat(recent.filter(id => id !== song.fileId)).slice(0, 30);
  store.set('recent', recent);
  if(currentTab === 'home') renderHome();
}

function toggleLike(fileId){
  const i = liked.indexOf(fileId);
  if(i === -1) liked.push(fileId); else liked.splice(i, 1);
  store.set('liked', liked);
  renderAll();
}

function addToQueue(fileId){
  const song = library.find(s => s.fileId === fileId);
  if(!song) return;
  queue.push(song);
  if(qi === -1){ qi = 0; playCurrent(false); }
  else if(!$('queueModal').hidden) renderQueue();
  toast('Added to queue');
}

function renderQueue(){
  $('queueList').innerHTML = queue.length ? queue.map((s, i) =>
    '<div class="qrow' + (i === qi ? ' cur' : '') + '" data-qplay="' + i + '">' +
    '<div class="mbox"><span>♪</span></div>' +
    '<div class="meta"><div class="t">' + esc(s.title) + '</div><div class="a">' + esc(s.artist) + '</div></div>' +
    '<button class="rmbtn" data-qrm="' + i + '">✕</button></div>').join('')
    : '<div class="empty" style="padding:24px">Queue is empty.</div>';
}

function exportLibrary(){
  const data = {
    app: 'ente-casette', version: 1, exportedAt: new Date().toISOString(),
    songs: library, playlists: playlists, liked: liked
  };
  const blob = new Blob([JSON.stringify(data)], {type: 'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'music-library.json';
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 800);
  toast('Library exported');
}

function importLibrary(file){
  const reader = new FileReader();
  reader.onload = () => {
    try{
      const data = JSON.parse(reader.result);
      if(!data || !Array.isArray(data.songs)) throw new Error('bad file');
      const seen = new Set(library.map(s => s.fileId));
      let added = 0;
      for(const s of data.songs){
        if(!s || !s.fileId || seen.has(s.fileId)) continue;
        seen.add(s.fileId);
        library.push({fileId: s.fileId, title: s.title || 'Unknown track',
          artist: s.artist || 'Unknown', duration: s.duration || 0, filePath: s.filePath || null});
        added++;
      }
      if(Array.isArray(data.playlists)){
        const existing = new Set(playlists.map(p => p.id));
        for(const p of data.playlists){
          if(p && p.id && !existing.has(p.id)){
            existing.add(p.id);
            playlists.push({id: p.id, name: p.name || 'Playlist',
              songIds: Array.isArray(p.songIds) ? p.songIds.slice() : []});
          }
        }
      }
      if(Array.isArray(data.liked)){
        for(const id of data.liked){ if(liked.indexOf(id) === -1) liked.push(id); }
      }
      store.set('library', library); store.set('playlists', playlists); store.set('liked', liked);
      renderAll();
      toast('Imported ' + added + ' song' + (added === 1 ? '' : 's'));
    }catch(e){ toast('Import failed: invalid file'); }
  };
  reader.readAsText(file);
}

function playNext(){
  if(!queue.length) return;
  if(repeatMode === 'one'){ audio.currentTime = 0; audio.play(); return; }
  if(qi < queue.length - 1){ qi++; playCurrent(false); }
  else if(repeatMode === 'all'){ qi = 0; playCurrent(false); }
}

function playPrev(){
  if(!queue.length) return;
  if(audio.currentTime > 3){ audio.currentTime = 0; return; }
  if(qi > 0){ qi--; playCurrent(false); }
}

audio.addEventListener('ended', playNext);
audio.addEventListener('play', setPlayIcon);
audio.addEventListener('pause', setPlayIcon);
audio.addEventListener('loadedmetadata', () => {
  if(!audio.duration) return;
  $('tCur').textContent = fmt(0);
  $('tRem').textContent = '-' + fmt(audio.duration);
});
audio.addEventListener('timeupdate', () => {
  if(!audio.duration) return;
  $('fpFill').style.width = (audio.currentTime / audio.duration * 100) + '%';
  $('tCur').textContent = fmt(audio.currentTime);
  $('tRem').textContent = '-' + fmt(audio.duration - audio.currentTime);
});
audio.addEventListener('error', () => {
  if(audio.src) toast('Could not load this track.');
});

/* ---------- playlists ---------- */
function openPicker(fileId){
  pickerSongId = fileId;
  $('pickerList').innerHTML = playlists.length
    ? playlists.map(p => '<div class="prow" data-pick="' + esc(p.id) + '">' +
      esc(p.name) + '<span style="color:var(--muted)">＋</span></div>').join('')
    : '<div class="empty" style="padding:16px">No playlists yet — create one below.</div>';
  $('newPlName').value = '';
  $('pickerModal').hidden = false;
}
function addToPlaylist(plId, fileId){
  const pl = playlists.find(p => p.id === plId);
  if(!pl) return;
  if(pl.songIds.indexOf(fileId) === -1){ pl.songIds.push(fileId); store.set('playlists', playlists); }
  $('pickerModal').hidden = true;
  toast('Added to ' + pl.name);
  renderAll();
}
function openPlaylist(plId){
  currentPlId = plId;
  const pl = playlists.find(p => p.id === plId);
  if(!pl) return;
  $('plTitle').textContent = pl.name;
  const map = new Map(library.map(s => [s.fileId, s]));
  const list = pl.songIds.map(id => map.get(id)).filter(Boolean);
  $('plSongs').innerHTML = list.length
    ? list.map((s) => songRow(s, 0, {remove: true})).join('')
    : '<div class="empty" style="padding:20px">Empty playlist.</div>';
  const rows = $('plSongs').querySelectorAll('[data-play]');
  rows.forEach((row) => {
    row.addEventListener('click', e => {
      if(e.target.closest('[data-rm]')) return;
      const fid = row.querySelector('[data-rm]').getAttribute('data-rm');
      const song = list.find(s => s.fileId === fid);
      queue = list.slice(); qi = list.indexOf(song);
      playCurrent(true);
      $('plModal').hidden = true;
    });
  });
  $('plSongs').querySelectorAll('[data-rm]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const fid = btn.getAttribute('data-rm');
      pl.songIds = pl.songIds.filter(id => id !== fid);
      store.set('playlists', playlists);
      openPlaylist(plId); renderAll();
    });
  });
  $('plModal').hidden = false;
}

/* ---------- events ---------- */
function bindListClicks(container){
  container.addEventListener('click', e => {
    const like = e.target.closest('[data-like]');
    if(like){ e.stopPropagation(); toggleLike(like.getAttribute('data-like')); return; }
    const q = e.target.closest('[data-queue]');
    if(q){ e.stopPropagation(); addToQueue(q.getAttribute('data-queue')); closeAllSwipes(); return; }
    const pa = e.target.closest('[data-pladd]');
    if(pa){ e.stopPropagation(); openPicker(pa.getAttribute('data-pladd')); closeAllSwipes(); return; }
    const delpl = e.target.closest('[data-delpl]');
    if(delpl){
      e.stopPropagation();
      if(confirm('Delete this playlist?')){
        playlists = playlists.filter(p => p.id !== delpl.getAttribute('data-delpl'));
        store.set('playlists', playlists); renderAll();
      }
      return;
    }
    const openpl = e.target.closest('[data-openpl]');
    if(openpl){ openPlaylist(openpl.getAttribute('data-openpl')); return; }
    const wrap = e.target.closest('.swipewrap');
    if(wrap && openSwipe === wrap){ closeSwipe(wrap); return; }
    const row = e.target.closest('[data-play]');
    if(row){ closeAllSwipes(); playFromList(parseInt(row.getAttribute('data-play'), 10), true); }
  });
}
['homeTab','libraryTab','likedTab','playlistsTab'].forEach(id => bindListClicks($(id)));

$('tabHome').addEventListener('click', () => switchTab('home'));
$('tabLibrary').addEventListener('click', () => switchTab('library'));
$('tabLiked').addEventListener('click', () => switchTab('liked'));
$('tabPlaylists').addEventListener('click', () => switchTab('playlists'));
$('search').addEventListener('input', renderAll);

$('mpToggle').addEventListener('click', e => {
  e.stopPropagation();
  if(audio.paused) audio.play(); else audio.pause();
});
$('miniPlayer').addEventListener('click', openPlayer);
/* swipe up on mini player -> open full player */
(function(){
  let sy = 0;
  $('miniPlayer').addEventListener('touchstart', e => { sy = e.touches[0].clientY; }, {passive: true});
  $('miniPlayer').addEventListener('touchend', e => {
    if(sy - e.changedTouches[0].clientY > 60) openPlayer();
  }, {passive: true});
})();
/* swipe down on full player -> minimize */
(function(){
  let sy = 0, sx = 0;
  $('fullPlayer').addEventListener('touchstart', e => {
    sy = e.touches[0].clientY; sx = e.touches[0].clientX;
  }, {passive: true});
  $('fullPlayer').addEventListener('touchend', e => {
    const dy = e.changedTouches[0].clientY - sy;
    const dx = e.changedTouches[0].clientX - sx;
    if(dy > 90 && dy > Math.abs(dx) * 1.4) closePlayer();
  }, {passive: true});
})();
$('fpClose').addEventListener('click', closePlayer);
$('btnPlay').addEventListener('click', () => { if(audio.paused) audio.play(); else audio.pause(); });
$('btnNext').addEventListener('click', playNext);
$('btnPrev').addEventListener('click', playPrev);
$('btnShuffle').addEventListener('click', () => {
  shuffle = !shuffle;
  $('btnShuffle').classList.toggle('on', shuffle);
  toast('Shuffle ' + (shuffle ? 'on' : 'off'));
});
$('btnRepeat').addEventListener('click', () => {
  repeatMode = repeatMode === 'off' ? 'all' : repeatMode === 'all' ? 'one' : 'off';
  $('btnRepeat').classList.toggle('on', repeatMode !== 'off');
  $('btnRepeat').textContent = repeatMode === 'one' ? '↻1' : '↻';
  toast('Repeat: ' + repeatMode);
});
$('btnQueue').addEventListener('click', () => { renderQueue(); $('queueModal').hidden = false; });
$('queueClose').addEventListener('click', () => { $('queueModal').hidden = true; });
$('queueModal').addEventListener('click', e => { if(e.target === $('queueModal')) $('queueModal').hidden = true; });
$('queueList').addEventListener('click', e => {
  const rm = e.target.closest('[data-qrm]');
  if(rm){
    e.stopPropagation();
    const i = parseInt(rm.getAttribute('data-qrm'), 10);
    queue.splice(i, 1);
    if(i < qi) qi--;
    else if(i === qi){ qi = -1; audio.pause(); audio.removeAttribute('src'); }
    if(!queue.length){ qi = -1; $('miniPlayer').hidden = true; document.body.style.paddingBottom = ''; }
    renderQueue(); renderAll(); setPlayIcon();
    return;
  }
  const row = e.target.closest('[data-qplay]');
  if(row){ qi = parseInt(row.getAttribute('data-qplay'), 10); playCurrent(false); renderQueue(); $('queueModal').hidden = true; }
});
$('fpTrack').addEventListener('click', e => {
  const r = $('fpTrack').getBoundingClientRect();
  const p = (e.clientX - r.left) / r.width;
  if(audio.duration) audio.currentTime = Math.max(0, Math.min(1, p)) * audio.duration;
});

/* export dropdown */
$('expBtn').addEventListener('click', e => {
  e.stopPropagation();
  $('expMenu').hidden = !$('expMenu').hidden;
});
document.addEventListener('click', e => {
  if(!e.target.closest('.dd')) $('expMenu').hidden = true;
});
$('expDo').addEventListener('click', () => { $('expMenu').hidden = true; exportLibrary(); });
$('impDo').addEventListener('click', () => { $('expMenu').hidden = true; $('importFile').click(); });
$('resetDo').addEventListener('click', () => {
  $('expMenu').hidden = true;
  if(confirm('Forget the bot token and erase library, playlists and history on this device?')){
    ['token','library','playlists','recent','liked','offset'].forEach(k => store.del(k));
    location.reload();
  }
});
$('syncBtn').addEventListener('click', () => syncLibrary(false));
$('importFile').addEventListener('change', e => {
  if(e.target.files && e.target.files[0]) importLibrary(e.target.files[0]);
  e.target.value = '';
});

$('pickerClose').addEventListener('click', () => { $('pickerModal').hidden = true; });
$('pickerModal').addEventListener('click', e => { if(e.target === $('pickerModal')) $('pickerModal').hidden = true; });
$('pickerList').addEventListener('click', e => {
  const row = e.target.closest('[data-pick]');
  if(row && pickerSongId) addToPlaylist(row.getAttribute('data-pick'), pickerSongId);
});
$('createPlBtn').addEventListener('click', () => {
  const name = $('newPlName').value.trim();
  if(!name){ toast('Type a playlist name'); return; }
  const pl = {id: 'pl' + Date.now(), name: name, songIds: []};
  playlists.push(pl); store.set('playlists', playlists);
  if(pickerSongId) addToPlaylist(pl.id, pickerSongId);
  else { $('pickerModal').hidden = true; renderAll(); }
});
$('plClose').addEventListener('click', () => { $('plModal').hidden = true; });
$('plModal').addEventListener('click', e => { if(e.target === $('plModal')) $('plModal').hidden = true; });

$('saveTokenBtn').addEventListener('click', async () => {
  const t = $('tokenInput').value.trim();
  if(!t){ toast('Paste your bot token first'); return; }
  token = t;
  try{
    await tg('getMe');
    store.set('token', token);
    enterApp();
    toast('Bot connected');
    syncLibrary(false);
  }catch(e){
    token = '';
    toast('Invalid token: ' + e.message);
  }
});

/* ---------- init ---------- */
function enterApp(){
  $('setupView').hidden = true;
  $('appView').hidden = false;
  audio.volume = 0.9;
  switchTab('home');
}
if(token){
  enterApp();
}else{
  $('setupView').hidden = false;
}
setPlayIcon();
