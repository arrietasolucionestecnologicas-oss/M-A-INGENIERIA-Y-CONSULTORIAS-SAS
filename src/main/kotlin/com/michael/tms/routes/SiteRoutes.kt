package com.michael.tms.routes

import com.michael.tms.model.CreateSiteRequest
import com.michael.tms.model.UpdateSiteRequest
import com.michael.tms.model.UserRole
import com.michael.tms.security.requireRole
import com.michael.tms.security.tmsPrincipal
import com.michael.tms.service.SiteService
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

fun Route.siteRoutes() {
    route("/sites") {
        post {
            val principal = call.requireRole(UserRole.ADMINISTRADOR, UserRole.SUPERVISOR)
            val request = call.receive<CreateSiteRequest>()
            call.respond(HttpStatusCode.Created, SiteService.create(principal.tenantId, request))
        }
        get {
            val principal = call.tmsPrincipal()
            call.respond(SiteService.list(principal.tenantId))
        }
        get("/{id}") {
            val principal = call.tmsPrincipal()
            val id = UUID.fromString(call.parameters["id"])
            call.respond(SiteService.get(principal.tenantId, id))
        }
        patch("/{id}") {
            val principal = call.requireRole(UserRole.ADMINISTRADOR, UserRole.SUPERVISOR)
            val id = UUID.fromString(call.parameters["id"])
            val request = call.receive<UpdateSiteRequest>()
            call.respond(SiteService.update(principal.tenantId, id, request))
        }
        delete("/{id}") {
            val principal = call.requireRole(UserRole.ADMINISTRADOR)
            val id = UUID.fromString(call.parameters["id"])
            SiteService.delete(principal.tenantId, id)
            call.respond(HttpStatusCode.NoContent)
        }
    }
}
