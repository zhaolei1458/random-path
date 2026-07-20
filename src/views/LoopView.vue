<script setup>
import { ref, computed, onMounted } from 'vue'
import { loadAddresses, saveLastRoute, loadLastRoute } from '../composables/useStorage.js'
import { geocode, setDetectedCity, detectCityFromGPS } from '../composables/useAMap.js'
import { useSuggest } from '../composables/useAutoComplete.js'
import { tryGenerateRoute, generateCompassLoop, generateMultipleRoutes, MAX_RETRIES, BIKE_SPEED, COMPASS, nameWaypoint, buildNavUrl, openNavigation, buildGPX, calcCalories } from '../composables/useRouteEngine.js'
import { rateDifficulty } from '../composables/useScoring.js'
import RouteThumbnail from '../components/RouteThumbnail.vue'

const toast = (m, t) => window.$toast?.(m, t)
const addresses = loadAddresses()
const { suggestions, showSuggest, searchAddress, pickSuggestion, closeSuggest } = useSuggest()

const center = ref({ name: '', lng: '', lat: '' })
const direction = ref('random'), timeMin = ref(90)
const loading = ref(false), loadingHint = ref('正在规划环形路线…'), tryInfo = ref(''), progress = ref(0)
const retryDots = ref(Array(10).fill(''))
const result = ref(null), resultShow = ref(false), collapseOpen = ref(false)
const multiResults = ref([]), activeResultIdx = ref(0)
const activeSuggest = ref(false)

const centerObj = computed(() => { const l = parseFloat(center.value.lng), a = parseFloat(center.value.lat); return (l && a && center.value.name) ? { lng: l, lat: a, name: center.value.name } : null })
const targetDist = computed(() => timeMin.value * 60 * BIKE_SPEED / 3.6)
const diffObj = computed(() => result.value ? rateDifficulty(result.value.totalDistance, result.value.totalClimb) : null)
const navUrl = computed(() => result.value && centerObj.value ? buildNavUrl(centerObj.value, centerObj.value, result.value.waypoints) : '')
const compass3x3 = computed(() => {
  const order = ['NW','N','NE','W','random','E','SW','S','SE']
  return order.map(k => COMPASS.find(c => c.key === k))
})

function onCenterInput() { activeSuggest.value = true; searchAddress(center.value.name) }
function selectSugg(i) { const p = pickSuggestion(i); if (p) { center.value = { name: p.name, lng: p.lng, lat: p.lat }; activeSuggest.value = false; toast(p.name) } }
function pickAddr(a) { const ad = addresses[a]; if (!ad) return; center.value = { name: ad.name, lng: ad.lng, lat: ad.lat }; toast(a) }
async function doGeocode() { const n = center.value.name; if (!n.trim()) { toast('请输入地名', 'warn'); return }; const r = await geocode(n); if (r) { center.value = { name: r.name, lng: r.lng, lat: r.lat }; toast('已获取坐标') } else toast('未找到该地点', 'warn') }
function locateMe() {
  if (!navigator.geolocation) { toast('浏览器不支持定位', 'warn'); return }
  toast('正在定位…')
  navigator.geolocation.getCurrentPosition(async (pos) => {
    const { longitude: lng, latitude: lat } = pos.coords
    center.value = { name: `📍 ${lng.toFixed(4)}, ${lat.toFixed(4)}`, lng: String(lng), lat: String(lat) }
    toast('已获取当前位置')
    try { const [name, city] = await Promise.all([nameWaypoint(lng, lat), detectCityFromGPS(lng, lat)]); if (name && name.length > 2) center.value.name = name; if (city) setDetectedCity(city) } catch(e) {}
  }, () => { toast('定位失败，请检查权限', 'warn') }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 })
}

async function doGenerate(isRetry = false) {
  multiResults.value = []
  if (center.value.name && !center.value.lng) await doGeocode()
  if (!center.value.name || !center.value.lng) { toast('请完善起点名称及坐标', 'warn'); return }
  const c = { name: center.value.name, lng: parseFloat(center.value.lng), lat: parseFloat(center.value.lat) }
  const td = targetDist.value
  const dirDeg = COMPASS.find(x => x.key === direction.value)?.deg ?? null
  if (!isRetry) resultShow.value = false
  loading.value = true; progress.value = 0; loadingHint.value = '正在规划环形路线…'; tryInfo.value = ''
  retryDots.value = Array(10).fill(''); retryDots.value[0] = 'current'
  try {
    const route = await tryGenerateRoute(c, c, {
      minDist: Math.round(td * 0.55), maxDist: Math.round(td * 1.5),
      waypointGenerator: (ld, mn, mx) => generateCompassLoop(c, td, dirDeg),
      onTry: (a, d, e) => {
        progress.value = Math.round((a / MAX_RETRIES) * 100)
        retryDots.value = Array(10).fill('').map((_, i) => i < a ? (e ? 'bad' : 'ok') : (i === a ? 'current' : ''))
        loadingHint.value = e ? `第${a}次: ${e}` : `第${a}次: ${(d/1000).toFixed(1)} km`
        tryInfo.value = loadingHint.value
      }
    })
    if (!route) { toast('生成失败，请重试', 'err'); loading.value = false; return }
    if (route.waypoints.length > 0) { tryInfo.value = '正在获取途经点地名…'; await Promise.all(route.waypoints.map(async (wp) => { wp.poiName = await nameWaypoint(wp.lng, wp.lat) })) }
    progress.value = 100; await new Promise(r => setTimeout(r, 200))
    result.value = route; resultShow.value = true; loading.value = false
    saveLastRoute({ type: 'loop', home: c, waypoints: route.waypoints, segments: route.segments, totalDistance: route.totalDistance, totalDuration: route.totalDuration, totalClimb: route.totalClimb, uphillSections: route.uphillSections, downhillSections: route.downhillSections, direction: direction.value, timeMin: timeMin.value })
  } catch (e) { toast('错误: ' + e.message, 'err'); loading.value = false }
}

async function doGenerateMultiple() {
  multiResults.value = []; resultShow.value = false
  if (center.value.name && !center.value.lng) await doGeocode()
  if (!center.value.name || !center.value.lng) { toast('请完善起点名称及坐标', 'warn'); return }
  const c = { name: center.value.name, lng: parseFloat(center.value.lng), lat: parseFloat(center.value.lat) }
  const td = targetDist.value
  const dirDeg = COMPASS.find(x => x.key === direction.value)?.deg ?? null
  loading.value = true; loadingHint.value = '正在生成多条环线…'; tryInfo.value = ''
  try {
    const results = await generateMultipleRoutes(c, c, { minDist: Math.round(td * 0.55), maxDist: Math.round(td * 1.5), waypointGenerator: (ld, mn, mx) => generateCompassLoop(c, td, dirDeg) }, 3)
    for (const r of results) {
      if (r.waypoints.length > 0) { tryInfo.value = '正在获取地名…'; await Promise.all(r.waypoints.map(async (wp) => { wp.poiName = await nameWaypoint(wp.lng, wp.lat) })) }
    }
    multiResults.value = results; activeResultIdx.value = 0
    if (results.length > 0) selectMulti(0)
  } catch (e) { toast('错误: ' + e.message, 'err') }
  loading.value = false
}

function selectMulti(i) { activeResultIdx.value = i; const r = multiResults.value[i]; if (!r) return; result.value = r; resultShow.value = true }

function openNav() { if (result.value && centerObj.value) openNavigation(centerObj.value, centerObj.value, result.value.waypoints) }
function copyNav() { if (navUrl.value) { navigator.clipboard?.writeText(navUrl.value); toast('已复制') } }
function downloadGpx() { if (result.value && centerObj.value) { const gpx = buildGPX(result.value, centerObj.value, centerObj.value); const blob = new Blob([gpx], { type: 'application/gpx+xml' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `RandomPath_Loop_${centerObj.value.name}_${(result.value.totalDistance/1000).toFixed(1)}km.gpx`; a.click(); URL.revokeObjectURL(a.href) } }

onMounted(async () => {
  const last = loadLastRoute()
  if (last && last.type === 'loop' && last.home) {
    center.value = { name: last.home.name, lng: String(last.home.lng), lat: String(last.home.lat) }
    if (last.direction) direction.value = last.direction
    if (last.timeMin) timeMin.value = last.timeMin
    if (last.segments?.length) { result.value = { waypoints: last.waypoints || [], segments: last.segments, totalDistance: last.totalDistance, totalDuration: last.totalDuration, totalClimb: last.totalClimb, uphillSections: last.uphillSections || [], downhillSections: last.downhillSections || [] }; resultShow.value = true }
    return
  }
  if (navigator.geolocation) {
    try {
      const pos = await new Promise((res, rej) => { navigator.geolocation.getCurrentPosition(res, rej, { enableHighAccuracy: true, timeout: 10000, maximumAge: 300000 }) })
      const { longitude: lng, latitude: lat } = pos.coords
      center.value = { name: `📍 ${lng.toFixed(4)}, ${lat.toFixed(4)}`, lng: String(lng), lat: String(lat) }
      try { const [name, city] = await Promise.all([nameWaypoint(lng, lat), detectCityFromGPS(lng, lat)]); if (name && name.length > 2) center.value.name = name; if (city) setDetectedCity(city) } catch(e) {}
    } catch(e) {}
  }
})
</script>

<template>
<div>
  <!-- Card 1: 起点 -->
  <div class="card">
    <div class="addr-quick"><span>地址簿：</span><button v-for="(v,k) in addresses" :key="k" class="btn btn-sm" style="background:#334155;color:#e2e8f0;font-size:10px;margin:1px" @click="pickAddr(k)">{{ k }}</button></div>
    <label style="font-size:12px;color:#8a8098;font-weight:600">📍 起点（从哪出发？）</label>
    <div class="row" style="position:relative">
      <input v-model="center.name" placeholder="地名搜索" style="flex:1" @input="onCenterInput" @focus="onCenterInput" @blur="setTimeout(closeSuggest,200)">
      <button class="btn btn-sm" style="background:#f97316;color:#fff;flex-shrink:0;padding:6px 10px;font-size:11px" @click="doGeocode">🔍</button>
      <button class="btn btn-sm" style="background:#42a5f5;color:#fff;flex-shrink:0;padding:6px 10px;font-size:11px" @click="locateMe">📍</button>
      <div v-if="showSuggest && activeSuggest" class="suggest-drop"><div v-for="(s,i) in suggestions" :key="i" class="suggest-item" @mousedown.prevent="selectSugg(i)"><span class="s-name">{{ s.name }}</span><span class="s-dist">{{ s.district }}</span></div></div>
    </div>
    <div class="row"><input v-model="center.lng" type="number" step="0.000001" placeholder="经度" style="flex:1"><input v-model="center.lat" type="number" step="0.000001" placeholder="纬度" style="flex:1"></div>
  </div>

  <!-- Card 2: 偏好 -->
  <div class="card">
    <label style="font-size:12px;color:#8a8098;font-weight:600;margin-bottom:8px;display:block">🧭 往哪个方向骑？</label>
    <div class="compass-grid">
      <button v-for="c in compass3x3" :key="c.key" :class="['compass-btn', { active: direction === c.key, center: c.key === 'random' }]" @click="direction = c.key">
        {{ c.label }}
      </button>
    </div>
    <label style="font-size:12px;color:#8a8098;font-weight:600;margin:12px 0 6px;display:block">⏱ 骑行时长</label>
    <div class="time-chips">
      <button v-for="t in [{m:60,l:'1小时'},{m:120,l:'2小时'},{m:180,l:'3小时'},{m:300,l:'半天'}]" :key="t.m" :class="['chip', { active: timeMin === t.m }]" @click="timeMin = t.m">{{ t.l }}</button>
    </div>
    <p style="font-size:11px;color:#a898b8;margin-top:6px">约 {{ (timeMin * BIKE_SPEED / 60).toFixed(0) }} km（按 {{ BIKE_SPEED }}km/h 估算）</p>
  </div>

  <!-- Card 3: 操作 -->
  <button class="btn btn-primary" :disabled="loading" @click="doGenerate(false)" style="font-size:18px;padding:16px">{{ loading ? '生成中…' : '🎲 随机环线！' }}</button>
  <button class="btn btn-secondary" :disabled="loading" @click="doGenerateMultiple" style="margin-top:6px;font-size:12px">📋 多看几条 (生成3条对比)</button>

  <!-- Loading -->
  <div v-if="loading" class="loading-overlay card">
    <div class="progress-ring">
      <svg width="64" height="64" viewBox="0 0 64 64"><circle class="bg" cx="32" cy="32" r="26"/><circle class="fg" cx="32" cy="32" r="26" :style="{strokeDasharray:163.36,strokeDashoffset:163.36-(progress/100)*163.36}"/></svg>
      <div class="txt">{{ progress }}%</div>
    </div>
    <p class="loading-hint">{{ loadingHint }}</p>
    <div class="retry-dots"><span v-for="(d,i) in retryDots" :key="i" :class="'retry-dot '+d"></span></div>
    <p class="try-count">{{ tryInfo }}</p>
  </div>

  <!-- 多路线选择 -->
  <div v-if="multiResults.length > 1" class="multi-cards">
    <div v-for="(r, i) in multiResults" :key="i" :class="['multi-card', { active: activeResultIdx === i }]" @click="selectMulti(i)">
      <div style="font-weight:700;font-size:13px;color:#5e5468">环线 {{ i+1 }}</div>
      <div style="font-size:11px;color:#a898b8">{{ (r.totalDistance/1000).toFixed(1) }}km · {{ Math.round(r.totalDuration/60) }}min · ↗{{ r.totalClimb||0 }}m</div>
      <RouteThumbnail :segments="r.segments" :waypoints="r.waypoints" :home="centerObj" :work="centerObj" :uphillSections="r.uphillSections" :downhillSections="r.downhillSections" />
    </div>
  </div>

  <!-- 结果 -->
  <div v-if="resultShow && result" class="card" style="animation:cardIn .4s cubic-bezier(.34,1.56,.64,1)">
    <div class="stats">
      <div class="stat"><div class="val">{{ (result.totalDistance/1000).toFixed(1) }}</div><div class="lbl">总距离 km</div></div>
      <div class="stat"><div class="val">{{ Math.round(result.totalDuration/60) }}</div><div class="lbl">预计 分钟</div></div>
      <div class="stat"><div class="val small" :style="{color: diffObj?.color}">{{ diffObj?.label }}</div><div class="lbl">难度</div></div>
    </div>
    <RouteThumbnail :segments="result.segments" :waypoints="result.waypoints" :home="centerObj" :work="centerObj" :uphillSections="result.uphillSections" :downhillSections="result.downhillSections" />
    <div class="route-thumb-legend"><span>🟢 起点</span><span>🟠 终点</span><span>🔵 途经点</span><span>🔴 上坡</span><span>🟢 下坡</span><span>⬆ 北</span></div>
    <div class="route-summary" v-html="'<strong>'+ (centerObj?.name||'') +'</strong> → '+ result.waypoints.map((w,i)=>w.poiName||'途经点'+(i+1)).join(' → ') +' → <strong>'+ (centerObj?.name||'') +'</strong>'"></div>
    <div class="collapse-toggle" :class="{open:collapseOpen}" @click="collapseOpen=!collapseOpen"><span class="arrow">▶</span> 详细数据</div>
    <div class="collapse-body" :class="{open:collapseOpen}">
      <div class="stats" style="margin-top:8px">
        <div class="stat"><div class="val small">{{ result.totalClimb != null ? result.totalClimb+'m' : '--' }}</div><div class="lbl">爬升 m</div></div>
        <div class="stat"><div class="val small">{{ calcCalories(result.totalDistance, result.totalDuration) }}kcal</div><div class="lbl">消耗</div></div>
        <div class="stat"><div class="val small">{{ result.waypoints.length }}</div><div class="lbl">途经点</div></div>
      </div>
      <div class="segments"><div class="seg" v-for="(seg,i) in result.segments" :key="i"><span class="seg-detail">第{{ i+1 }}段: {{ i===0 ? centerObj?.name : (result.waypoints[i-1]?.poiName||'途经点'+i) }} → {{ i===result.segments.length-1 ? centerObj?.name : (result.waypoints[i]?.poiName||'途经点'+(i+1)) }}</span><span class="seg-nums">{{ (seg.distance/1000).toFixed(1) }}km · {{ Math.round(seg.duration/60) }}min</span></div></div>
      <div class="waypoints-info"><span v-for="(wp,i) in result.waypoints" :key="i">途经点{{ i+1 }}: {{ wp.lng.toFixed(5) }}, {{ wp.lat.toFixed(5) }} {{ wp.poiName||'' }}</span></div>
      <div v-if="result.uphillSections?.length" class="slope-box uphill">
        <div class="slope-title">🔴 上坡路段 (坡度≥5%)</div>
        <div class="slope-item" v-for="(sec, i) in result.uphillSections" :key="'u'+i">
          <span class="slope-badge" :class="sec.avgGrade >= 8 ? 'steep' : 'moderate'">{{ sec.avgGrade >= 8 ? '🔴' : '🟠' }} 第{{ i+1 }}段</span>
          <span class="slope-data">{{ sec.length }} km ↗ {{ sec.climb }}m</span>
          <span class="slope-grade">均{{ sec.avgGrade }}% / 最{{ sec.maxGrade }}%</span>
        </div>
      </div>
      <div v-if="result.downhillSections?.length" class="slope-box downhill">
        <div class="slope-title">🟢 下坡路段 (坡度≥5%)</div>
        <div class="slope-item" v-for="(sec, i) in result.downhillSections" :key="'d'+i">
          <span class="slope-badge">{{ sec.avgGrade >= 8 ? '🟢' : '🟢' }} 第{{ i+1 }}段</span>
          <span class="slope-data">{{ sec.length }} km ↘ {{ sec.descent }}m</span>
          <span class="slope-grade">均{{ sec.avgGrade }}% / 最{{ sec.maxGrade }}%</span>
        </div>
      </div>
    </div>
    <button class="btn btn-nav" @click="openNav">开始导航</button>
    <div class="nav-link-box"><div class="label">高德导航链接（可复制）：</div><div class="url">{{ navUrl }}</div></div>
    <div style="display:flex;gap:8px;margin-top:8px"><button class="btn btn-sm btn-secondary" style="flex:1" @click="copyNav">复制</button><button class="btn btn-sm btn-secondary" style="flex:1" @click="downloadGpx">GPX</button></div>
    <button class="btn btn-secondary" style="margin-top:8px" @click="doGenerate(true)">换一条</button>
  </div>
</div>
</template>
