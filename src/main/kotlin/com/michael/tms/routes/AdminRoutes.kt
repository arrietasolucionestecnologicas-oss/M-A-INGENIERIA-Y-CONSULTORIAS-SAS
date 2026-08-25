package com.michael.tms.routes

import com.michael.tms.model.CreateTenantRequest
import com.michael.tms.model.UpdateTenantRequest
import com.michael.tms.security.ForbiddenException
import com.michael.tms.service.AdminService
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.ApplicationCall
import io.ktor.server.application.call
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.delete
import io.ktor.server.routing.get
import io.ktor.server.routing.patch
import io.ktor.server.routing.post
import io.ktor.server.routing.route
import java.util.UUID

private suspend fun requireMasterToken(call: ApplicationCall) {
    val token = call.request.headers["X-Master-Token"]
    if (token.isNullOrBlank() || !AdminService.isValidMasterToken(token)) {
        throw ForbiddenException("Token maestro inválido")
    }
}

/**
 * Endpoints de administración del SaaS. Protegidos exclusivamente por X-Master-Token,
 * sin relación con el JWT de usuarios ni con X-Tenant-ID (por eso viven fuera de /api/v1
 * y del Kill Switch de tenant).
 */
fun Route.adminRoutes() {
    route("/admin/tenant") {
        post {
            requireMasterToken(call)
            val request = call.receive<CreateTenantRequest>()
            call.respond(HttpStatusCode.Created, AdminService.createTenant(request))
        }
        get {
            requireMasterToken(call)
            call.respond(AdminService.listTenants())
        }
        get("/{id}") {
            requireMasterToken(call)
            val id = UUID.fromString(call.parameters["id"])
            call.respond(AdminService.getTenant(id))
        }
        patch("/{id}") {
            requireMasterToken(call)
            val id = UUID.fromString(call.parameters["id"])
            val request = call.receive<UpdateTenantRequest>()
            call.respond(AdminService.updateTenant(id, request))
        }
        delete("/{id}") {
            requireMasterToken(call)
            val id = UUID.fromString(call.parameters["id"])
            call.respond(AdminService.deactivateTenant(id))
        }
    }
}
