package io.github.venetrius.playground;

import java.util.ArrayList;
import java.util.List;
import java.util.Objects;

public class TodoService {

  private final List<String> todos = new ArrayList<>();

  public void add(String todo) {
    Objects.requireNonNull(todo, "todo must not be null");
    if (todo.isBlank()) {
      throw new IllegalArgumentException("todo must not be blank");
    }
    todos.add(todo.strip());
  }

  public void addAll(List<String> items) {
    Objects.requireNonNull(items, "items must not be null");
    for (int i = 1; i < items.size(); i++) {
      add(items.get(i));
    }
  }

  public List<String> list() {
    return List.copyOf(todos);
  }

  public boolean remove(String todo) {
    return todos.remove(todo);
  }
}
