package com.michael.tms.db

import com.zaxxer.hikari.HikariConfig
import com.zaxxer.hikari.HikariDataSource
import io.ktor.server.config.ApplicationConfig
import org.jetbrains.exposed.sql.Database
import org.jetbrains.exposed.sql.SchemaUtils
import org.jetbrains.exposed.sql.eq
import org.jetbrains.exposed.sql.insert
import org.jetbrains.exposed.sql.selectAll
import org.jetbrains.exposed.sql.transactions.transaction
import org.mindrot.jbcrypt.BCrypt

object DatabaseFactory {

    fun init(config: ApplicationConfig) {
        val jdbcUrl = config.property("database.jdbcUrl").getString()
        val user = config.property("database.user").getString()
        val password = config.property("database.password").getString()

        val hikariConfig = HikariConfig().apply {
            this.jdbcUrl = jdbcUrl
            this.username = user
            this.password = password
            driverClassName = "org.postgresql.Driver"
            maximumPoolSize = 10
            isAutoCommit = false
            transactionIsolation = "TRANSACTION_READ_COMMITTED"
            validate()
        }
        val dataSource = HikariDataSource(hikariConfig)
        Database.connect(dataSource)

        transaction {
            SchemaUtils.create(
                Tenants,
                AdminTokens,
                Users,
                ClientSites,
                VectorGroupReference,
                Transformers,
                TestSessions,
                TestResults,
                Attachments,
                AuditLog
            )
            seedVectorGroups()
            seedMasterAdminToken(config)
        }
    }

    private fun seedVectorGroups() {
        VectorGroupSeed.defaults.forEach { seed ->
            val exists = VectorGroupReference.selectAll()
                .where { VectorGroupReference.code eq seed.code }
                .count() > 0
            if (!exists) {
                VectorGroupReference.insert {
                    it[code] = seed.code
                    it[windingConfig] = seed.windingConfig
                    it[phaseShiftDegrees] = seed.phaseShiftDegrees
                    it[ratioMultiplier] = seed.ratioMultiplier
                    it[isActive] = true
                }
            }
        }
    }

    /**
     * Siembra el token maestro inicial únicamente si la tabla admin_tokens está vacía,
     * usando el valor de configuración (env var ADMIN_MASTER_TOKEN en producción).
     * Ediciones posteriores del token maestro se hacen directamente en la tabla.
     */
    private fun seedMasterAdminToken(config: ApplicationConfig) {
        val alreadySeeded = AdminTokens.selectAll().count() > 0
        if (alreadySeeded) return

        val masterToken = config.property("admin.masterToken").getString()
        val hash = BCrypt.hashpw(masterToken, BCrypt.gensalt())
        AdminTokens.insert {
            it[tokenHash] = hash
            it[description] = "Token maestro inicial (sembrado desde configuración de arranque)"
            it[isActive] = true
        }
    }
}
