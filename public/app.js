const $ = s => document.querySelector(s);
const tokenKey='br_token', deviceKey='br_device';
let token=localStorage.getItem(tokenKey), device=localStorage.getItem(deviceKey);
if(!device){ device=crypto.randomUUID(); localStorage.setItem(deviceKey,device); }
function api(url,opts={}){ opts.headers={...(opts.headers||{}), ...(token?{Authorization:`Bearer ${token}`}:{})}; if(!opts.headers['Content-Type'] && opts.body && typeof opts.body==='string') opts.headers['Content-Type']='application/json'; return fetch(url,opts); }
async function login(e){e.preventDefault();$('#loginMsg').textContent=''; const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json','X-Device-Id':device},body:JSON.stringify({username:$('#username').value,password:$('#password').value})}); const d=await r.json(); if(!r.ok){$('#loginMsg').textContent=d.error||'خطا';return} token=d.token; device=d.deviceId; localStorage.setItem(tokenKey,token); localStorage.setItem(deviceKey,device); showApp();}
async function showApp(){ if(!token){$('#loginView').classList.remove('hidden');return} const r=await api('/api/me'); if(!r.ok){localStorage.removeItem(tokenKey);token=null;$('#loginView').classList.remove('hidden');return} $('#loginView').classList.add('hidden');$('#appView').classList.remove('hidden');$('#logout').classList.remove('hidden');loadCourses();}
async function loadCourses(){const r=await api('/api/courses'); const data=await r.json(); $('#courses').innerHTML=data.map(c=>`<article class="course card"><div class="course-icon">▶</div><div><h2>${esc(c.title)}</h2><p>${esc(c.description)}</p><span>${c.lessons.length} درس</span></div><button onclick="openCourse('${c.id}')">مشاهده دوره</button></article>`).join('') || '<div class="card empty">هنوز دوره‌ای برای این حساب فعال نشده.</div>';}
async function openCourse(id){const r=await api('/api/courses/'+id);const c=await r.json();const p=$('#lessonPanel');p.classList.remove('hidden');p.innerHTML=`<div class="panel-head"><div><div class="eyebrow">COURSE</div><h2>${esc(c.title)}</h2><p>${esc(c.description)}</p></div><button class="ghost" onclick="$('#lessonPanel').classList.add('hidden')">بستن</button></div><div class="lessons">${c.lessons.map((l,i)=>`<button class="lesson" onclick="playLesson('${c.id}','${l.id}','${esc(l.title)}')"><b>${String(i+1).padStart(2,'0')}</b><span>${esc(l.title)}<small>${esc(l.description||'')}</small></span><i>›</i></button>`).join('')}</div><div id="player" class="player hidden"></div>`;p.scrollIntoView({behavior:'smooth'});}
function playLesson(courseId,lessonId,title){const p=$('#player');p.classList.remove('hidden');p.innerHTML=`<div class="capture-shield" aria-hidden="true"><span>محتوای محافظت‌شده</span></div><div class="watermark">${esc($('#username').value||'STUDENT')} • ${esc(device.slice(0,8))}</div><video controls controlsList="nodownload noplaybackrate" disablePictureInPicture playsinline oncontextmenu="return false" src="/api/media/${courseId}/${lessonId}"></video><h3>${title}</h3><small>پخش محافظت‌شده • دانلود مستقیم و برخی روش‌های ثبت تصویر غیرفعال/محدود شده</small>`;installCaptureProtection(p);}
function installCaptureProtection(player){const video=player.querySelector('video');
  const shield=player.querySelector('.capture-shield');
  const protect=()=>{video.pause(); video.style.visibility='hidden'; shield.classList.add('active');};
  const restore=()=>{video.style.visibility='visible'; shield.classList.remove('active');};
  document.addEventListener('visibilitychange',()=>{if(document.hidden) protect(); else restore();},{once:false});
  window.addEventListener('blur',protect,{once:false});
  window.addEventListener('focus',restore,{once:false});
  video.addEventListener('contextmenu',e=>e.preventDefault());
}
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
// Browser-level deterrence. A normal website cannot control the OS screenshot/recording function itself.
document.addEventListener('keydown',e=>{if(e.key==='PrintScreen'||e.key==='F12'||(e.ctrlKey&&e.shiftKey&&['I','J','C'].includes(e.key.toUpperCase()))||(e.ctrlKey&&['u','s','p'].includes(e.key.toLowerCase()))){e.preventDefault();document.querySelectorAll('video').forEach(v=>v.pause());}});
document.addEventListener('contextmenu',e=>e.preventDefault());
document.addEventListener('dragstart',e=>e.preventDefault());
$('#loginForm').addEventListener('submit',login);$('#logout').onclick=async()=>{await api('/api/logout',{method:'POST'});localStorage.removeItem(tokenKey);token=null;location.reload();};showApp();