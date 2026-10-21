package dev.cuongnb.herdly.android

import java.net.URI
import java.net.URISyntaxException

/** Where the app points: the server's [origin] and the [url] to load first (a pairing link or the root). */
data class ServerLink(val origin: String, val url: String)

/**
 * Reads a pasted pairing link (`http://192.0.2.10:7380/pair?t=…`) or a server address
 * (`192.0.2.10:7380`). Text without a scheme is taken as http. Null when it is not an http(s) link.
 */
fun parseServerLink(text: String): ServerLink? {
    val trimmed = text.trim()
    if (trimmed.isEmpty()) return null
    val full = if ("://" in trimmed) trimmed else "http://$trimmed"
    val uri = parse(full) ?: return null
    val origin = originOf(uri) ?: return null
    val url = if (uri.rawPath.isNullOrEmpty()) "$origin/" + (uri.rawQuery?.let { "?$it" } ?: "") else full
    return ServerLink(origin, url)
}

/** Whether [url] has the same scheme, host and port as [origin]. */
fun isSameOrigin(url: String, origin: String): Boolean {
    val uri = parse(url) ?: return false
    return originOf(uri) == origin
}

private fun parse(text: String): URI? =
    try {
        URI(text)
    } catch (_: URISyntaxException) {
        null
    }

private fun originOf(uri: URI): String? {
    val scheme = uri.scheme?.lowercase() ?: return null
    if (scheme != "http" && scheme != "https") return null
    val host = uri.host?.lowercase()?.takeIf { it.isNotEmpty() } ?: return null
    val port = if (uri.port == -1) "" else ":${uri.port}"
    return "$scheme://$host$port"
}
