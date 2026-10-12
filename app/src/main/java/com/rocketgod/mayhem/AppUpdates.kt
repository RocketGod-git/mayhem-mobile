package com.rocketgod.mayhem

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import com.google.android.play.core.appupdate.AppUpdateInfo
import com.google.android.play.core.appupdate.AppUpdateManagerFactory
import com.google.android.play.core.install.model.AppUpdateType
import com.google.android.play.core.install.model.UpdateAvailability
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * Update check run at launch, with two paths behind one dialog.
 *
 * A Play-installed build must go through Play's in-app update flow: Play policy does not allow an app
 * distributed by Play to fetch and install its own APK, and only Play knows which track the user is on.
 * That API reports the available build by VERSION CODE only — there is no way to ask it for the version
 * name — which is why a Play user sees "build 7" where a sideloader sees "v0.4.1".
 *
 * A sideloaded build has no such restriction and no Play to ask, so it checks the GitHub release feed and
 * opens the release page; the install itself is the user's business.
 *
 * [skip] remembers the exact build that was declined, so Skip silences that one version and nothing else —
 * the next build asks again.
 */
object AppUpdates {
    private const val REPO = "RocketGod-git/mayhem-mobile"
    private const val PREFS = "mayhem"
    private const val KEY_SKIPPED = "update_skipped"
    const val REQ_UPDATE = 4711

    data class Available(
        /** What is installed now, e.g. "0.4.0 (4)". */
        val current: String,
        /** What is on offer: a version name from GitHub, or "build <code>" from Play. */
        val offered: String,
        /** True when Play serves this install, so the button hands off to Play's own update flow. */
        val fromPlay: Boolean,
        /** Sideload only: the release page to open. */
        val url: String? = null,
    )

    private val _available = MutableStateFlow<Available?>(null)
    val available: StateFlow<Available?> = _available.asStateFlow()

    @Volatile private var playInfo: AppUpdateInfo? = null

    private fun currentLabel() = "${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})"

    /** com.android.vending means Play installed it, including from a test track. */
    private fun installedByPlay(ctx: Context): Boolean = runCatching {
        val installer =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R)
                ctx.packageManager.getInstallSourceInfo(ctx.packageName).installingPackageName
            else
                @Suppress("DEPRECATION") ctx.packageManager.getInstallerPackageName(ctx.packageName)
        installer == "com.android.vending"
    }.getOrDefault(false)

    /** Call once per launch. Never blocks the UI; the dialog appears only if something is actually newer. */
    fun check(ctx: Context) {
        if (installedByPlay(ctx)) checkPlay(ctx) else checkGitHub(ctx)
    }

    private fun checkPlay(ctx: Context) {
        val mgr = AppUpdateManagerFactory.create(ctx.applicationContext)
        mgr.appUpdateInfo
            .addOnSuccessListener { info ->
                val code = info.availableVersionCode()
                if (info.updateAvailability() != UpdateAvailability.UPDATE_AVAILABLE) {
                    Diag.log("updates: Play reports no update (installed ${BuildConfig.VERSION_CODE})")
                    return@addOnSuccessListener
                }
                val offered = "build $code"
                if (skipped(ctx) == offered) {
                    Diag.log("updates: $offered was skipped, staying quiet")
                    return@addOnSuccessListener
                }
                playInfo = info
                _available.value = Available(currentLabel(), offered, fromPlay = true)
                Diag.log("updates: Play has $offered, installed is ${BuildConfig.VERSION_CODE}")
            }
            .addOnFailureListener { e -> Diag.log("updates: Play check failed — ${e.message}") }
    }

    private fun checkGitHub(ctx: Context) {
        CoroutineScope(Dispatchers.IO).launch {
            runCatching {
                val c = (URL("https://api.github.com/repos/$REPO/releases/latest").openConnection() as HttpURLConnection)
                c.connectTimeout = 8000; c.readTimeout = 8000
                c.setRequestProperty("Accept", "application/vnd.github+json")
                val body = c.inputStream.bufferedReader().use { it.readText() }
                c.disconnect()
                JSONObject(body)
            }.onSuccess { j ->
                // The release workflow publishes a rolling "latest" tag, so compare the version NAME it carries
                // rather than the tag, which never changes.
                val name = j.optString("name")
                val tag = j.optString("tag_name")
                val offered = Regex("v?\\d+\\.\\d+\\.\\d+").find(name)?.value ?: tag
                val url = j.optString("html_url").ifEmpty { "https://github.com/$REPO/releases" }
                if (offered.trimStart('v') == BuildConfig.VERSION_NAME) {
                    Diag.log("updates: GitHub release is $offered, same as installed")
                    return@onSuccess
                }
                if (skipped(ctx) == offered) {
                    Diag.log("updates: $offered was skipped, staying quiet")
                    return@onSuccess
                }
                _available.value = Available(currentLabel(), offered, fromPlay = false, url = url)
                Diag.log("updates: GitHub has $offered, installed is ${BuildConfig.VERSION_NAME}")
            }.onFailure { e -> Diag.log("updates: GitHub check failed — ${e.message}") }
        }
    }

    /** UPDATE: hand off to Play, or open the release page for a sideload. */
    fun start(activity: Activity) {
        val a = _available.value ?: return
        if (a.fromPlay) {
            val info = playInfo
            val mgr = AppUpdateManagerFactory.create(activity.applicationContext)
            if (info != null) {
                runCatching { mgr.startUpdateFlowForResult(info, AppUpdateType.IMMEDIATE, activity, REQ_UPDATE) }
                    .onFailure { e -> Diag.log("updates: could not start Play flow — ${e.message}") }
            }
        } else {
            runCatching {
                activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(a.url ?: "https://github.com/$REPO/releases")))
            }.onFailure { e -> Diag.log("updates: could not open the release page — ${e.message}") }
        }
        _available.value = null
    }

    /** SKIP: silence this one build, ask again on the next. */
    fun skip(ctx: Context) {
        val a = _available.value ?: return
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY_SKIPPED, a.offered).apply()
        Diag.log("updates: skipped ${a.offered}")
        _available.value = null
    }

    fun dismiss() { _available.value = null }

    private fun skipped(ctx: Context) =
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_SKIPPED, null)
}
