package com.michael.tms.plugins

import com.michael.tms.db.Tenants
import com.michael.tms.model.ErrorResponse
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.Application
import io.ktor.server.application.ApplicationCallPipeline
import io.ktor.server.application.call
import io.ktor.server.request.path
import io.ktor.server.response.respond
import io.ktor.util.AttributeKey
import org.jetbrains.exposed.sql.eq
import org.jetbrains.exposed.sql.selectAll
import org.jetbrains.exposed.sql.transactions.transaction
import java.util.UUID

val TenantIdAttrKey = AttributeKey<UUID>("TenantId")

/**
 * Kill Switch del SaaS: intercepta toda petición bajo /api/v1 antes de que llegue al
 * routing/autenticación. Si tenants.is_active = false (o el tenant no existe), aborta con
 * 402/403 sin ejecutar ninguna lógica de negocio. Los endpoints /admin/* (protegidos por
 * token maestro) y /health quedan fuera de este control.
 */
fun Application.configureTenantKillSwitch() {
    intercept(ApplicationCallPipeline.Plugins) {
        val path = call.request.path()
        if (!path.startsWith("/api/v1")) {
            return@intercept
        }

        val tenantIdHeader = call.request.headers["X-Tenant-ID"]
        if (tenantIdHeader.isNullOrBlank()) {
            call.respond(HttpStatusCode.BadRequest, ErrorResponse("Header X-Tenant-ID requerido"))
            finish()
            return@intercept
        }

        val tenantId = try {
            UUID.fromString(tenantIdHeader)
        } catch (ex: IllegalArgumentException) {
            call.respond(HttpStatusCode.BadRequest, ErrorResponse("X-Tenant-ID inválido"))
            finish()
            return@intercept
        }

        val isActive = transaction {
            Tenants.selectAll()
                .where { Tenants.id eq tenantId }
                .singleOrNull()
                ?.get(Tenants.isActive)
        }

        when (isActive) {
            null -> {
                call.respond(HttpStatusCode.NotFound, ErrorResponse("Tenant no encontrado"))
                finish()
            }
            false -> {
                call.respond(HttpStatusCode.PaymentRequired, ErrorResponse("Cuenta suspendida. Contacte al administrador."))
                finish()
            }
            true -> {
                call.attributes.put(TenantIdAttrKey, tenantId)
            }
        }
    }
}
