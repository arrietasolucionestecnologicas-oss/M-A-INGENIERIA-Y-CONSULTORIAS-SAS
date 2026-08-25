package com.michael.tms.routes

import com.michael.tms.model.CreateTransformerRequest
import com.michael.tms.model.UpdateTransformerRequest
import com.michael.tms.model.UserRole
import com.michael.tms.security.requireRole
import com.michael.tms.security.tmsPrincipal
import com.michael.tms.service.TestSessionService
import com.michael.tms.service.TransformerService
import io.ktor.http.HttpStatusCode
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

/**
 * RBAC: TECNICO tiene únicamente lectura sobre el perfil de transformador (datos de placa,
 * tap_config, custom_tap_ratio_matrix). Solo SUPERVISOR/ADMINISTRADOR pueden crear o modificar
 * estos datos, dado que determinan el veredicto de aprobación/rechazo de las pruebas.
 */
fun Route.transformerRoutes() {
    route("/transformers") {
        post {
            val principal = call.requireRole(UserRole.ADMINISTRADOR, UserRole.SUPERVISOR)
            val request = call.receive<CreateTransformerRequest>()
            call.respond(HttpStatusCode.Created, TransformerService.create(principal.tenantId, request))
        }
        get {
            val principal = call.tmsPrincipal()
            val siteId = call.request.queryParameters["siteId"]?.let { UUID.fromString(it) }
            call.respond(TransformerService.list(principal.tenantId, siteId))
        }
        get("/{id}") {
            val principal = call.tmsPrincipal()
            val id = UUID.fromString(call.parameters["id"])
            call.respond(TransformerService.get(principal.tenantId, id))
        }
        patch("/{id}") {
            val principal = call.requireRole(UserRole.ADMINISTRADOR, UserRole.SUPERVISOR)
            val id = UUID.fromString(call.parameters["id"])
            val request = call.receive<UpdateTransformerRequest>()
            call.respond(TransformerService.update(principal.tenantId, id, request, principal.userId))
        }
        delete("/{id}") {
            val principal = call.requireRole(UserRole.ADMINISTRADOR)
            val id = UUID.fromString(call.parameters["id"])
            call.respond(TransformerService.deactivate(principal.tenantId, id, principal.userId))
        }
        get("/{id}/test-sessions") {
            val principal = call.tmsPrincipal()
            val transformerId = UUID.fromString(call.parameters["id"])
            call.respond(TestSessionService.listByTransformer(principal.tenantId, transformerId))
        }
    }
}
