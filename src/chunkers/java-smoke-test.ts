import { chunkJavaFile } from "./java.js";
import type { RawDocument } from "../types.js";

const sample = `
package com.acme.users;

import org.springframework.web.bind.annotation.*;
import org.springframework.stereotype.Service;
import java.util.List;

/** Handles user-related HTTP endpoints. */
@RestController
@RequestMapping("/api/users")
public class UserController {

    private final UserService userService;

    public UserController(UserService userService) {
        this.userService = userService;
    }

    /** Returns a single user by id. */
    @GetMapping("/{id}")
    public User getUser(@PathVariable String id) {
        return userService.findById(id);
    }

    @PostMapping
    public User createUser(@RequestBody User user) {
        return userService.create(user);
    }

    private boolean isValid(User user) {
        return user.getName() != null;
    }
}

/** Plain data-transfer object with no behavior of its own. */
public record UserDto(String id, String name) {}
`;

const doc: RawDocument = {
  sourceType: "code",
  sourceId: "github:acme/users-service:src/main/java/com/acme/users/UserController.java",
  content: sample,
  metadata: {
    repo: "acme/users-service",
    provider: "github",
    ref: "main",
    filePath: "src/main/java/com/acme/users/UserController.java",
    language: "java",
    url: "https://github.com/acme/users-service/blob/main/src/main/java/com/acme/users/UserController.java",
    contentHash: "test-hash",
  },
};

const chunks = chunkJavaFile(doc);

console.log(`Extracted ${chunks.length} chunks:\n`);
for (const c of chunks) {
  console.log("─".repeat(60));
  console.log(`symbol: ${c.metadata.symbolName}  type: ${c.metadata.symbolType}  exported: ${c.metadata.exported}`);
  console.log(`lines: ${c.metadata.startLine}-${c.metadata.endLine}  markers: ${c.metadata.frameworkMarkers?.join(", ")}`);
  console.log(`imports found in file: ${c.metadata.imports?.join(", ")}`);
  console.log("\n--- embedded content ---");
  console.log(c.content);
  console.log();
}
