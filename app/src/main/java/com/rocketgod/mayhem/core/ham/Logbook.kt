package com.rocketgod.mayhem.core.ham

import android.content.Context
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/** The HAM logbook: contacts kept on the phone, the form being filled in, and what is known about its callsign. */
object Logbook {
    data class Draft(
        val call: String = "", val rstS: String = "", val rstR: String = "", val name: String = "", val qth: String = "",
        val grid: String = "", val notes: String = "", val mode: String = "",
    )

    private val _entries = MutableStateFlow<List<Qso>>(emptyList())
    val entries: StateFlow<List<Qso>> = _entries.asStateFlow()
    private val _draft = MutableStateFlow(Draft())
    val draft: StateFlow<Draft> = _draft.asStateFlow()
    /** The contact being edited, "" when logging a new one. */
    private val _editing = MutableStateFlow("")
    val editing: StateFlow<String> = _editing.asStateFlow()
    private val _info = MutableStateFlow<CallInfo?>(null)
    val info: StateFlow<CallInfo?> = _info.asStateFlow()
    private val _busy = MutableStateFlow(false)
    val busy: StateFlow<Boolean> = _busy.asStateFlow()
    private var file: File? = null
    private val io = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    fun load(ctx: Context) {
        val f = File(ctx.filesDir, "logbook.json"); file = f
        if (!f.exists()) return
        runCatching {
            val a = JSONArray(f.readText())
            _entries.value = (0 until a.length()).map { i ->
                val o = a.getJSONObject(i)
                Qso(o.getString("id"), o.getString("call"), o.getLong("ts"), o.optLong("freq"), o.optString("mode"),
                    o.optString("rstS"), o.optString("rstR"), o.optString("name"), o.optString("qth"), o.optString("grid"),
                    o.optString("notes"), o.optString("country").ifEmpty { null })
            }
        }
    }

    private fun save() {
        val a = JSONArray()
        for (q in _entries.value) a.put(JSONObject().put("id", q.id).put("call", q.call).put("ts", q.ts).put("freq", q.freq).put("mode", q.mode)
            .put("rstS", q.rstS).put("rstR", q.rstR).put("name", q.name).put("qth", q.qth).put("grid", q.grid).put("notes", q.notes)
            .put("country", q.country ?: ""))
        val f = file ?: return
        io.launch { runCatching { f.writeText(a.toString()) } }
    }

    fun setDraft(d: Draft) {
        val callChanged = parseCall(d.call).base != parseCall(_draft.value.call).base
        _draft.value = d
        if (callChanged) _info.value = if (d.call.isNotBlank()) offlineInfo(d.call) else null
    }

    /** Ask the online sources about the draft's callsign; fills name / QTH / grid where the form is still empty. */
    fun lookup() {
        val call = _draft.value.call.trim()
        if (call.isEmpty()) return
        _busy.value = true
        io.launch {
            val i = lookupCall(call)
            _info.value = i
            val d = _draft.value
            _draft.value = d.copy(
                name = d.name.ifEmpty { i.name ?: "" },
                qth = d.qth.ifEmpty { i.qth?.replace(Regex("^call area \\d · "), "") ?: "" },
                grid = d.grid.ifEmpty { i.grid ?: "" },
            )
            _busy.value = false
        }
    }

    /** Start a new contact from elsewhere (an FT8 decode, a DMR caller) and go to the logbook. */
    fun prefill(d: Draft) { _editing.value = ""; _info.value = null; setDraft(d) }

    fun clearForm() { _editing.value = ""; _draft.value = Draft(); _info.value = null }

    /** Save the form as a new contact (or the edited one). Returns an error to show, or null. */
    fun save(freq: Long, modeNow: String): String? {
        val d = _draft.value
        val call = parseCall(d.call).call
        if (call.isEmpty()) return "a callsign, at least"
        val list = _entries.value.toMutableList()
        val idx = list.indexOfFirst { it.id == _editing.value }
        val base = if (idx >= 0) list[idx] else Qso("${System.currentTimeMillis()}-$call", call, System.currentTimeMillis(), freq, d.mode.ifEmpty { modeNow })
        val q = base.copy(call = call, rstS = d.rstS, rstR = d.rstR, name = d.name, qth = d.qth, grid = d.grid.uppercase(), notes = d.notes,
            country = _info.value?.country ?: base.country)
        if (idx >= 0) list[idx] = q else list.add(0, q)
        _entries.value = list
        save()
        clearForm()
        return null
    }

    fun edit(id: String) {
        val x = _entries.value.firstOrNull { it.id == id } ?: return
        _editing.value = id
        _draft.value = Draft(x.call, x.rstS, x.rstR, x.name, x.qth, x.grid, x.notes, x.mode)
        _info.value = offlineInfo(x.call)
    }

    fun delete(id: String) {
        _entries.value = _entries.value.filterNot { it.id == id }
        if (_editing.value == id) clearForm()
        save()
    }

    fun deleteAll() { _entries.value = emptyList(); clearForm(); save() }

    /** Merge an ADIF file's contacts; returns how many were new. */
    fun import(adif: String): Int {
        val have = _entries.value.map { it.id }.toHashSet()
        val got = fromAdif(adif).filter { it.id !in have }
        _entries.value = (_entries.value + got).sortedByDescending { it.ts }
        save()
        return got.size
    }

    fun csv(): String = "call,utc,freq_mhz,band,mode,rst_sent,rst_rcvd,name,qth,grid,country,notes\n" + _entries.value.joinToString("\n") { x ->
        val utc = java.time.Instant.ofEpochMilli(x.ts).toString()
        listOf(x.call, utc, "%.6f".format(x.freq / 1e6), bandOfHz(x.freq), x.mode, x.rstS, x.rstR, x.name, x.qth, x.grid, x.country ?: "", x.notes)
            .joinToString(",") { "\"" + it.replace("\"", "\"\"") + "\"" }
    } + "\n"
}
