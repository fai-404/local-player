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
let library = store.get('library', []);   // [{fileId,title,artist,duration,filePath}]
let playlists = store.get('playlists', []); // [{id,name,songIds:[]}]
let recent  = store.get('recent', []);    // [fileId,...]
let queue = [], qi = -1;
let shuffle = false, repeatMode = 'off';  // off | all | one
let currentTab = 'songs', currentPlId = null, pickerSongId = null;
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
  const btn = $('fpSync');
  if(!silent && btn){ btn.innerHTML = '<span class="spinner"></span>Syncing...'; btn.disabled = true; }
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
    if(!silent && btn){ btn.textContent = 'Sync new songs'; btn.disabled = false; }
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
  const right = opts.remove
    ? '<button class="rmbtn" data-rm="' + esc(s.fileId) + '" title="Remove">✕</button>'
    : '<span class="dur">' + fmt(s.duration) + '</span>' +
      '<button class="addbtn" data-add="' + esc(s.fileId) + '" title="Add to playlist">＋</button>';
  return '<div class="song' + (playing ? ' playing' : '') + '" data-play="' + idx + '">' +
    '<div class="disc">♪</div>' +
    '<div class="meta"><div class="t">' + esc(s.title) + '</div>' +
    '<div class="a">' + esc(s.artist) + '</div></div>' + right + '</div>';
}

function currentSongList(){
  if(currentTab === 'playlists' && currentPlId){
    const pl = playlists.find(p => p.id === currentPlId);
    if(!pl) return [];
    const map = new Map(library.map(s => [s.fileId, s]));
    return pl.songIds.map(id => map.get(id)).filter(Boolean);
  }
  if(currentTab === 'recent'){
    const map = new Map(library.map(s => [s.fileId, s]));
    return recent.map(id => map.get(id)).filter(Boolean);
  }
  const q = $('search').value.trim().toLowerCase();
  if(!q) return library.slice();
  return library.filter(s =>
    (s.title + ' ' + s.artist).toLowerCase().indexOf(q) !== -1);
}

function renderSongs(){
  const el = $('songsTab');
  const list = currentSongList();
  if(currentTab !== 'songs'){ el.innerHTML = ''; return; }
  if(!library.length){
    el.innerHTML = '<div class="empty">No songs yet.<br>Send audio files to your bot, then tap <b>sync</b> above.</div>';
    return;
  }
  if(!list.length){ el.innerHTML = '<div class="empty">No matches.</div>'; return; }
  el.innerHTML = list.map((s, i) => songRow(s, i)).join('');
}

function renderPlaylists(){
  const el = $('playlistsTab');
  if(currentTab !== 'playlists'){ el.innerHTML = ''; return; }
  if(!playlists.length){
    el.innerHTML = '<div class="empty">No playlists yet.<br>Tap ＋ on any song to add it to a new playlist.</div>';
    return;
  }
  el.innerHTML = playlists.map(p =>
    '<div class="song" data-openpl="' + esc(p.id) + '">' +
    '<div class="disc">▤</div><div class="meta"><div class="t">' + esc(p.name) + '</div>' +
    '<div class="a">' + p.songIds.length + ' songs</div></div>' +
    '<button class="rmbtn" data-delpl="' + esc(p.id) + '" title="Delete">✕</button></div>'
  ).join('');
}

function renderRecent(){
  const el = $('recentTab');
  if(currentTab !== 'recent'){ el.innerHTML = ''; return; }
  const list = currentSongList();
  if(!list.length){ el.innerHTML = '<div class="empty">Nothing played yet.</div>'; return; }
  el.innerHTML = list.map((s, i) => songRow(s, i)).join('');
}

function renderAll(){ renderSongs(); renderPlaylists(); renderRecent(); }

function switchTab(name){
  currentTab = name; currentPlId = null;
  $('tabSongs').classList.toggle('active', name === 'songs');
  $('tabPlaylists').classList.toggle('active', name === 'playlists');
  $('tabRecent').classList.toggle('active', name === 'recent');
  $('songsTab').hidden = name !== 'songs';
  $('playlistsTab').hidden = name !== 'playlists';
  $('recentTab').hidden = name !== 'recent';
  renderAll();
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
      title: song.title, artist: song.artist, album: 'My Music'
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
  $('fpTitle').textContent = song.title;
  $('fpArtist').textContent = song.artist;
  document.body.style.paddingBottom = '96px';
}

async function playFromList(listIndex){
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
  await playCurrent();
}

async function playCurrent(){
  const song = queue[qi];
  if(!song) return;
  showMini(song);
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
  if(currentTab === 'recent') renderRecent();
}

function playNext(){
  if(!queue.length) return;
  if(repeatMode === 'one'){ audio.currentTime = 0; audio.play(); return; }
  if(qi < queue.length - 1){ qi++; playCurrent(); }
  else if(repeatMode === 'all'){ qi = 0; playCurrent(); }
}

function playPrev(){
  if(!queue.length) return;
  if(audio.currentTime > 3){ audio.currentTime = 0; return; }
  if(qi > 0){ qi--; playCurrent(); }
}

audio.addEventListener('ended', playNext);
audio.addEventListener('play', setPlayIcon);
audio.addEventListener('pause', setPlayIcon);
audio.addEventListener('loadedmetadata', () => {
  $('seek').max = Math.floor(audio.duration || 0);
  $('tDur').textContent = fmt(audio.duration);
});
audio.addEventListener('timeupdate', () => {
  if(!audio.duration) return;
  if(document.activeElement !== $('seek')) $('seek').value = Math.floor(audio.currentTime);
  $('tCur').textContent = fmt(audio.currentTime);
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
  // rewire: data-play indexes refer to this modal list
  const rows = $('plSongs').querySelectorAll('[data-play]');
  rows.forEach((row, i) => {
    row.addEventListener('click', e => {
      if(e.target.closest('[data-rm]')) return;
      const fid = row.querySelector('[data-rm]').getAttribute('data-rm');
      const song = list.find(s => s.fileId === fid);
      queue = list.slice(); qi = list.indexOf(song);
      playCurrent();
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
    const add = e.target.closest('[data-add]');
    if(add){ e.stopPropagation(); openPicker(add.getAttribute('data-add')); return; }
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
    const row = e.target.closest('[data-play]');
    if(row){ playFromList(parseInt(row.getAttribute('data-play'), 10)); }
  });
}
['songsTab','playlistsTab','recentTab'].forEach(id => bindListClicks($(id)));

$('tabSongs').addEventListener('click', () => switchTab('songs'));
$('tabPlaylists').addEventListener('click', () => switchTab('playlists'));
$('tabRecent').addEventListener('click', () => switchTab('recent'));
$('search').addEventListener('input', () => { if(currentTab === 'songs') renderSongs(); });

$('mpToggle').addEventListener('click', e => {
  e.stopPropagation();
  if(audio.paused) audio.play(); else audio.pause();
});
$('miniPlayer').addEventListener('click', () => { $('fullPlayer').hidden = false; });
$('fpClose').addEventListener('click', () => { $('fullPlayer').hidden = true; });
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
$('seek').addEventListener('change', () => { audio.currentTime = parseInt($('seek').value, 10) || 0; });
$('seek').addEventListener('input', () => { $('tCur').textContent = fmt($('seek').value); });
$('vol').addEventListener('input', () => { audio.volume = $('vol').value / 100; });
$('fpSync').addEventListener('click', () => syncLibrary(false));
$('syncBtn').addEventListener('click', () => syncLibrary(false));

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
    const me = await tg('getMe');
    store.set('token', token);
    enterApp();
    toast('Connected as @' + (me.username || 'bot'));
    syncLibrary(false);
  }catch(e){
    token = '';
    toast('Invalid token: ' + e.message);
  }
});
$('resetBtn').addEventListener('click', () => {
  if(confirm('Forget the bot token and erase library, playlists and history on this device?')){
    ['token','library','playlists','recent','offset'].forEach(k => store.del(k));
    location.reload();
  }
});

/* ---------- init ---------- */
function enterApp(){
  $('setupView').hidden = true;
  $('appView').hidden = false;
  audio.volume = 0.9;
  renderAll();
}
if(token){
  enterApp();
}else{
  $('setupView').hidden = false;
}
setPlayIcon();
