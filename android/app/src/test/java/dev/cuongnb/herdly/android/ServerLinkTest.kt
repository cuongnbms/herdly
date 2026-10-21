package dev.cuongnb.herdly.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ServerLinkTest {
    @Test
    fun pairingLinkKeepsTheTokenAndYieldsItsOrigin() {
        val link = parseServerLink("http://192.0.2.10:7380/pair?t=abc123")
        assertEquals(ServerLink("http://192.0.2.10:7380", "http://192.0.2.10:7380/pair?t=abc123"), link)
    }

    @Test
    fun surroundingWhitespaceIsIgnored() {
        val link = parseServerLink("  http://192.0.2.10:7380/pair?t=abc123\n")
        assertEquals("http://192.0.2.10:7380/pair?t=abc123", link?.url)
    }

    @Test
    fun bareHostAndPortDefaultsToHttp() {
        val link = parseServerLink("192.0.2.10:7380")
        assertEquals(ServerLink("http://192.0.2.10:7380", "http://192.0.2.10:7380/"), link)
    }

    @Test
    fun httpsWithoutPortKeepsTheSchemeAndHasNoPort() {
        val link = parseServerLink("https://herdly.example")
        assertEquals(ServerLink("https://herdly.example", "https://herdly.example/"), link)
    }

    @Test
    fun hostIsLowercasedInTheOrigin() {
        assertEquals("http://herdly.example:7380", parseServerLink("http://Herdly.Example:7380/")?.origin)
    }

    @Test
    fun rejectsTextThatIsNotAnHttpLink() {
        assertNull(parseServerLink(""))
        assertNull(parseServerLink("   "))
        assertNull(parseServerLink("ftp://192.0.2.10/pair?t=x"))
        assertNull(parseServerLink("not a link"))
        assertNull(parseServerLink("http://"))
    }

    @Test
    fun sameOriginComparesSchemeHostAndPort() {
        val origin = "http://192.0.2.10:7380"
        assertTrue(isSameOrigin("http://192.0.2.10:7380/", origin))
        assertTrue(isSameOrigin("http://192.0.2.10:7380/pair?t=x", origin))
        assertFalse(isSameOrigin("http://192.0.2.10:7381/", origin))
        assertFalse(isSameOrigin("https://192.0.2.10:7380/", origin))
        assertFalse(isSameOrigin("https://github.com/cuongnbms/herdly", origin))
        assertFalse(isSameOrigin("mailto:a@b.c", origin))
    }
}
