package com.michael.tms.db

import org.jetbrains.exposed.dao.id.EntityID
import org.jetbrains.exposed.dao.id.IdTable
import java.util.UUID

fun UUID.toEntityId(table: IdTable<UUID>): EntityID<UUID> = EntityID(this, table)
