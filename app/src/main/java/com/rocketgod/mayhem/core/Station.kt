package com.rocketgod.mayhem.core

import android.content.Context
import com.rocketgod.mayhem.core.ham.gridToLatLon
import com.rocketgod.mayhem.core.ham.latLonToGrid
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONObject

/** The operator: callsign, name, grid, licence, DMR ID and APRS SSID, set in Settings and used by HAM, APRS and the logbook. */
object Station {
    data class Info(
        val call: String = "", val name: String = "", val grid: String = "", val license: String = "",
        val dmrId: String = "", val aprsSsid: String = "9",
    )

    private val _info = MutableStateFlow(Info())
    val info: StateFlow<Info> = _info.asStateFlow()
    private var ctx: Context? = null

    fun load(c: Context) {
        ctx = c.applicationContext
        val s = c.getSharedPreferences("mayhem", Context.MODE_PRIVATE).getString("station", null) ?: return
        runCatching {
            val j = JSONObject(s)
            _info.value = Info(j.optString("call"), j.optString("name"), j.optString("grid"), j.optString("license"),
                j.optString("dmrId"), j.optString("aprsSsid", "9"))
        }
    }

    fun update(f: (Info) -> Info) {
        val v = f(_info.value); _info.value = v
        val j = JSONObject().put("call", v.call).put("name", v.name).put("grid", v.grid).put("license", v.license)
            .put("dmrId", v.dmrId).put("aprsSsid", v.aprsSsid)
        ctx?.getSharedPreferences("mayhem", Context.MODE_PRIVATE)?.edit()?.putString("station", j.toString())?.apply()
    }

    /** The grid as set, or worked out from the phone's position. */
    fun grid(): String {
        val s = _info.value
        if (s.grid.isNotBlank()) return s.grid.uppercase()
        return Geo.fix.value?.let { latLonToGrid(it.first, it.second) } ?: ""
    }

    /** Where the station is: the grid square's centre if one is set, else the phone's fix. */
    fun latLon(): Pair<Double, Double>? {
        val s = _info.value
        if (s.grid.isNotBlank()) gridToLatLon(s.grid)?.let { return it }
        return Geo.fix.value
    }

    /** The callsign with the APRS SSID, or a placeholder when nothing is set. */
    fun aprsCall(): String {
        val s = _info.value
        return if (s.call.isNotBlank()) s.call + (if (s.aprsSsid.isNotBlank() && s.aprsSsid != "0") "-${s.aprsSsid}" else "") else "N0CALL-9"
    }
}
