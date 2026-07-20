import { reactive } from 'vue'

const AK = 'radompath_addresses_v4', HK = 'radompath_history', MH = 20
const DEFAULT_ADDRESSES = {}

// ===== 地址簿单例：所有组件共享同一个 reactive，确保数据始终同步 =====
let _addressesSingleton = null

function _loadFromStorage() {
  try {
    const raw = localStorage.getItem(AK)
    if (raw) {
      const parsed = JSON.parse(raw)
      // 验证数据完整性：必须是纯对象（不能是数组、null、基本类型）
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed
      }
      // 数据格式不对 → 视为损坏
      console.warn('地址簿数据格式异常，已重置', parsed)
      localStorage.removeItem(AK)
      return { ...DEFAULT_ADDRESSES }
    }
  } catch (e) {
    console.warn('地址簿数据损坏（JSON解析失败），已重置', e)
    try { localStorage.removeItem(AK) } catch (_) {}
  }
  // 无数据或已清理 → 返回空对象，但不写入 localStorage（首次使用时让它保持干净）
  return { ...DEFAULT_ADDRESSES }
}

export function loadAddresses() {
  // 如果单例已存在且是 reactive，直接返回
  if (_addressesSingleton) return _addressesSingleton

  const data = _loadFromStorage()
  _addressesSingleton = reactive(data)
  return _addressesSingleton
}

/**
 * 强制从 localStorage 重新加载地址簿（用于跨标签页同步等场景）
 * 会把当前单例里的数据替换掉
 */
export function reloadAddresses() {
  const data = _loadFromStorage()
  if (!_addressesSingleton) {
    _addressesSingleton = reactive(data)
    return _addressesSingleton
  }
  // 清空并重新填充：先删掉所有旧 key，再写入新数据
  for (const k of Object.keys(_addressesSingleton)) {
    delete _addressesSingleton[k]
  }
  Object.assign(_addressesSingleton, data)
  return _addressesSingleton
}

export function saveAddresses(a) {
  // 确保保存的是普通对象而非 reactive 代理
  const plain = {}
  const obj = a || _addressesSingleton || {}
  for (const [k, v] of Object.entries(obj)) {
    // 跳过无效条目：没有名字或坐标不完整的
    if (!v || !v.name) continue
    const lng = Number(v.lng)
    const lat = Number(v.lat)
    if (isNaN(lng) || isNaN(lat)) continue
    plain[k] = { name: String(v.name), lng, lat }
  }
  try {
    localStorage.setItem(AK, JSON.stringify(plain))
  } catch (e) {
    console.error('保存地址簿失败（可能 localStorage 已满）', e)
  }
}

export function deleteAddress(alias) {
  const addresses = loadAddresses() // 获取单例
  if (!addresses[alias]) return false

  // 直接从单例上删除（视图会自动响应更新）
  delete addresses[alias]
  // 持久化
  saveAddresses(addresses)
  return true
}

// ===== 历史记录 =====
export function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HK)) || [] } catch (e) { return [] }
}
export function saveHistory(e) {
  const h = loadHistory()
  h.unshift({ ...e, date: new Date().toISOString() })
  if (h.length > MH) h.length = MH
  localStorage.setItem(HK, JSON.stringify(h))
}
export function getRecentSectors(n = 5) {
  return loadHistory().slice(0, n).map(h => h.sector).filter(s => s !== undefined)
}

// ===== 途经点冷却追踪 =====
const TK = 'radompath_waypoint_tracker'
export function saveWaypointTracker(tracker) {
  try {
    const plain = tracker.map(w => ({ lng: w.lng, lat: w.lat, count: w.count, cooldown: w.cooldown }))
    localStorage.setItem(TK, JSON.stringify(plain))
  } catch(e) {}
}
export function loadWaypointTracker() {
  try {
    const raw = localStorage.getItem(TK)
    if (raw) { const arr = JSON.parse(raw); if (Array.isArray(arr)) return arr.filter(w => w.lng != null && w.lat != null) }
  } catch(e) {}
  return []
}

// ===== 最后路线缓存 =====
const RK = 'radompath_last_route'
export function saveLastRoute(data) {
  try {
    const slim = {
      type: data.type,
      home: data.home, work: data.work,
      waypoints: (data.waypoints || []).map(w => ({ lng: w.lng, lat: w.lat, poiName: w.poiName, name: w.name })),
      segments: (data.segments || []).map(s => ({
        from: s.from, to: s.to, distance: s.distance, duration: s.duration, polyline: s.polyline, idx: s.idx
      })),
      totalDistance: data.totalDistance, totalDuration: data.totalDuration,
      sector: data.sector, totalClimb: data.totalClimb,
      savedAt: Date.now()
    }
    localStorage.setItem(RK, JSON.stringify(slim))
  } catch(e) {}
}
export function loadLastRoute() {
  try {
    const raw = localStorage.getItem(RK)
    if (raw) return JSON.parse(raw)
  } catch(e) {}
  return null
}
export function clearLastRoute() { localStorage.removeItem(RK) }
