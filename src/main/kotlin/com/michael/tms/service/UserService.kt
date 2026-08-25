package com.michael.tms.service

import com.michael.tms.db.Tenants
import com.michael.tms.db.Users
import com.michael.tms.db.toEntityId
import com.michael.tms.model.CreateUserRequest
import com.michael.tms.model.UpdateUserRequest
import com.michael.tms.model.UserResponse
import com.michael.tms.security.BadRequestException
import com.michael.tms.security.ConflictException
import com.michael.tms.security.NotFoundException
import com.michael.tms.security.PasswordHashing
import org.jetbrains.exposed.sql.ResultRow
import org.jetbrains.exposed.sql.and
import org.jetbrains.exposed.sql.eq
import org.jetbrains.exposed.sql.insertAndGetId
import org.jetbrains.exposed.sql.selectAll
import org.jetbrains.exposed.sql.transactions.transaction
import org.jetbrains.exposed.sql.update
import java.time.LocalDateTime
import java.util.UUID

object UserService {

    fun create(tenantId: UUID, request: CreateUserRequest): UserResponse = transaction {
        val exists = Users.selectAll()
            .where { (Users.tenantId eq tenantId) and (Users.email eq request.email) }
            .count() > 0
        if (exists) throw ConflictException("Ya existe un usuario con el correo ${request.email} en este tenant")

        val id = Users.insertAndGetId {
            it[Users.tenantId] = tenantId.toEntityId(Tenants)
            it[email] = request.email
            it[passwordHash] = PasswordHashing.hash(request.password)
            it[fullName] = request.fullName
            it[role] = request.role.name
            it[licenseNumber] = request.licenseNumber
            it[isActive] = true
        }
        toResponse(fetchRow(tenantId, id.value))
    }

    fun list(tenantId: UUID): List<UserResponse> = transaction {
        Users.selectAll().where { Users.tenantId eq tenantId }.map { toResponse(it) }
    }

    fun get(tenantId: UUID, id: UUID): UserResponse = transaction {
        toResponse(fetchRow(tenantId, id))
    }

    fun update(tenantId: UUID, id: UUID, request: UpdateUserRequest): UserResponse = transaction {
        fetchRow(tenantId, id)

        Users.update({ (Users.tenantId eq tenantId) and (Users.id eq id) }) { stmt ->
            request.fullName?.let { stmt[fullName] = it }
            request.role?.let { stmt[role] = it.name }
            request.licenseNumber?.let { stmt[licenseNumber] = it }
            request.isActive?.let { stmt[isActive] = it }
            request.password?.let {
                if (it.length < 8) throw BadRequestException("La contraseña debe tener al menos 8 caracteres")
                stmt[passwordHash] = PasswordHashing.hash(it)
            }
            stmt[updatedAt] = LocalDateTime.now()
        }

        toResponse(fetchRow(tenantId, id))
    }

    fun delete(tenantId: UUID, id: UUID) = transaction {
        fetchRow(tenantId, id)
        Users.update({ (Users.tenantId eq tenantId) and (Users.id eq id) }) {
            it[isActive] = false
            it[updatedAt] = LocalDateTime.now()
        }
        Unit
    }

    fun findActiveForLogin(tenantId: UUID, email: String): ResultRow? = transaction {
        Users.selectAll()
            .where { (Users.tenantId eq tenantId) and (Users.email eq email) and (Users.isActive eq true) }
            .singleOrNull()
    }

    private fun fetchRow(tenantId: UUID, id: UUID): ResultRow =
        Users.selectAll().where { (Users.tenantId eq tenantId) and (Users.id eq id) }.singleOrNull()
            ?: throw NotFoundException("Usuario no encontrado: $id")

    private fun toResponse(row: ResultRow) = UserResponse(
        id = row[Users.id].value.toString(),
        email = row[Users.email],
        fullName = row[Users.fullName],
        role = row[Users.role],
        licenseNumber = row[Users.licenseNumber],
        isActive = row[Users.isActive],
        createdAt = row[Users.createdAt].iso()
    )
}
