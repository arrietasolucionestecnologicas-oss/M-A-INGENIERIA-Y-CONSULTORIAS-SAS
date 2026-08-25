package com.michael.tms.security

import org.mindrot.jbcrypt.BCrypt

object PasswordHashing {
    fun hash(rawPassword: String): String = BCrypt.hashpw(rawPassword, BCrypt.gensalt())
    fun matches(rawPassword: String, hash: String): Boolean = BCrypt.checkpw(rawPassword, hash)
}
