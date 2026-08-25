package com.michael.tms.security

import com.auth0.jwt.JWT
import com.auth0.jwt.JWTVerifier
import com.auth0.jwt.algorithms.Algorithm
import io.ktor.server.config.ApplicationConfig
import java.util.Date
import java.util.UUID

object JwtConfig {
    private lateinit var secret: String
    lateinit var issuer: String
        private set
    lateinit var audience: String
        private set
    lateinit var realm: String
        private set
    private var expirationMinutes: Long = 480

    fun init(config: ApplicationConfig) {
        secret = config.property("jwt.secret").getString()
        issuer = config.property("jwt.issuer").getString()
        audience = config.property("jwt.audience").getString()
        realm = config.property("jwt.realm").getString()
        expirationMinutes = config.property("jwt.expirationMinutes").getString().toLong()
    }

    fun generateToken(userId: UUID, tenantId: UUID, role: String): String {
        val now = Date()
        val expiry = Date(now.time + expirationMinutes * 60_000L)
        return JWT.create()
            .withIssuer(issuer)
            .withAudience(audience)
            .withClaim("userId", userId.toString())
            .withClaim("tenantId", tenantId.toString())
            .withClaim("role", role)
            .withIssuedAt(now)
            .withExpiresAt(expiry)
            .sign(Algorithm.HMAC256(secret))
    }

    fun verifier(): JWTVerifier = JWT.require(Algorithm.HMAC256(secret))
        .withIssuer(issuer)
        .withAudience(audience)
        .build()
}
