const tg = window.Telegram.WebApp;

const state = {
  tasks: [],
  editingTaskId: null,
  initData: tg.initData || "",
  activeTab: "add",
  timezone: "",
  pendingOps: 0,
  viewportMinHeight: 420,
};

const els = {
  tabAddBtn: document.getElementById("tabAddBtn"),
  tabTasksBtn: document.getElementById("tabTasksBtn"),
  tabAdd: document.getElementById("tabAdd"),
  tabTasks: document.getElementById("tabTasks"),
  tabsViewport: document.getElementById("tabsViewport"),
  tasksCount: document.getElementById("tasksCount"),
  taskText: document.getElementById("taskText"),
  taskDatetime: document.getElementById("taskDatetime"),
  formTitle: document.getElementById("formTitle"),
  editActions: document.getElementById("editActions"),
  cancelEditBtn: document.getElementById("cancelEditBtn"),
  timezoneInput: document.getElementById("timezoneInput"),
  timezoneCurrent: document.getElementById("timezoneCurrent"),
  saveTimezoneBtn: document.getElementById("saveTimezoneBtn"),
  refreshBtn: document.getElementById("refreshBtn"),
  loadingBar: document.getElementById("loadingBar"),
  toastStack: document.getElementById("toastStack"),
  userAvatar: document.getElementById("userAvatar"),
  userAvatarFallback: document.getElementById("userAvatarFallback"),
  userName: document.getElementById("userName"),
  userUsername: document.getElementById("userUsername"),
  userTariff: document.getElementById("userTariff"),
  tasks: document.getElementById("tasks"),
  emptyState: document.getElementById("emptyState"),
  taskTemplate: document.getElementById("taskTemplate"),
};

function isBusy() {
  return state.pendingOps > 0;
}

function setBusy(value) {
  if (value) {
    state.pendingOps += 1;
  } else {
    state.pendingOps = Math.max(0, state.pendingOps - 1);
  }

  const busy = isBusy();
  els.loadingBar.hidden = !busy;
  els.saveTimezoneBtn.disabled = busy;
  els.refreshBtn.disabled = busy;
  tg.MainButton.isActive = !busy;
}

function showToast(message, type = "success") {
  const toast = document.createElement("div");
  toast.className = `toast ${type === "error" ? "toast-error" : "toast-success"}`;
  toast.textContent = message;
  els.toastStack.appendChild(toast);

  window.setTimeout(() => {
    toast.remove();
  }, 3400);
}

function handleError(error, fallback = "Ошибка") {
  const message = error?.message || fallback;
  showToast(message, "error");
}

function switchTab(tabName) {
  state.activeTab = tabName;

  const isAdd = tabName === "add";
  els.tabAddBtn.classList.toggle("active", isAdd);
  els.tabTasksBtn.classList.toggle("active", !isAdd);

  els.tabAdd.hidden = !isAdd;
  els.tabAdd.classList.toggle("active", isAdd);
  els.tabTasks.hidden = isAdd;
  els.tabTasks.classList.toggle("active", !isAdd);

  updateMainButtonState();
  syncViewportHeight();
}

function updateMainButtonState() {
  if (!state.initData || state.activeTab !== "add") {
    tg.MainButton.hide();
    return;
  }

  tg.MainButton.show();
  tg.MainButton.isActive = !isBusy();
  if (state.editingTaskId) {
    tg.MainButton.setText("Сохранить изменения");
    tg.MainButton.color = "#1b7fb8";
  } else {
    tg.MainButton.setText("Добавить задачу");
    tg.MainButton.color = "#2497d9";
  }
}

function withAuthHeaders(extra = {}) {
  return {
    ...extra,
    "X-Telegram-Init-Data": state.initData,
    "Content-Type": "application/json",
  };
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: withAuthHeaders(options.headers || {}),
  });

  if (response.status === 204) {
    return null;
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.detail || "Request failed");
  }
  return data;
}

function normalizeDatetimeValue(value) {
  return value.slice(0, 16);
}

function localInputToApi(value) {
  return normalizeDatetimeValue(value).replace("T", " ");
}

function apiToLocalInput(value) {
  return value.replace(" ", "T");
}

function pluralizeTasks(count) {
  if (count === 1) {
    return "задача";
  }
  if (count >= 2 && count <= 4) {
    return "задачи";
  }
  return "задач";
}

function updateTasksCount() {
  const count = state.tasks.length;
  els.tasksCount.textContent = `${count} ${pluralizeTasks(count)}`;
}

function resetForm() {
  state.editingTaskId = null;
  els.formTitle.textContent = "Новая задача";
  els.editActions.hidden = true;
  els.taskText.value = "";
  els.taskDatetime.value = "";
  updateMainButtonState();
  syncViewportHeight();
}

function startEdit(task) {
  state.editingTaskId = task.id;
  els.formTitle.textContent = "Редактирование задачи";
  els.editActions.hidden = false;
  els.taskText.value = task.text;
  els.taskDatetime.value = apiToLocalInput(task.scheduled_local);
  switchTab("add");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function renderTasks() {
  els.tasks.innerHTML = "";

  if (!state.tasks.length) {
    els.emptyState.hidden = false;
    updateTasksCount();
    syncViewportHeight();
    return;
  }

  els.emptyState.hidden = true;
  state.tasks.forEach((task) => {
    const node = els.taskTemplate.content.firstElementChild.cloneNode(true);
    node.querySelector(".task-title").textContent = task.text;
    node.querySelector(".task-time").textContent = `${task.scheduled_local} (${task.reminded ? "напомнено" : "ожидает"})`;

    node.querySelector('[data-action="edit"]').addEventListener("click", () => {
      startEdit(task);
    });

    node.querySelector('[data-action="delete"]').addEventListener("click", async () => {
      try {
        setBusy(true);
        await api(`/api/tasks/${task.id}`, { method: "DELETE" });
        await loadTasks();
        if (state.editingTaskId === task.id) {
          resetForm();
        }
        showToast("Задача удалена", "success");
      } catch (error) {
        handleError(error, "Ошибка удаления задачи");
      } finally {
        setBusy(false);
      }
    });

    els.tasks.appendChild(node);
  });

  updateTasksCount();
  syncViewportHeight();
}

function renderTimezone(timezone) {
  state.timezone = timezone;
  els.timezoneInput.value = timezone;
  els.timezoneCurrent.textContent = `Текущий пояс: ${timezone}`;
}

function renderUserInfo() {
  const user = tg.initDataUnsafe?.user;
  if (!user) {
    els.userName.textContent = "Пользователь Telegram";
    els.userUsername.textContent = "@username";
    els.userTariff.textContent = "Бесплатный тариф";
    return;
  }

  const fullName = [user.first_name, user.last_name].filter(Boolean).join(" ").trim() || "Пользователь Telegram";
  const username = user.username ? `@${user.username}` : "@без_username";

  els.userName.textContent = fullName;
  els.userUsername.textContent = username;
  els.userTariff.textContent = "Бесплатный тариф";

  if (user.photo_url) {
    els.userAvatar.src = user.photo_url;
    els.userAvatar.hidden = false;
    els.userAvatarFallback.hidden = true;
  } else {
    const initials = fullName
      .split(" ")
      .filter(Boolean)
      .slice(0, 2)
      .map((chunk) => chunk[0].toUpperCase())
      .join("") || "TG";

    els.userAvatar.hidden = true;
    els.userAvatarFallback.hidden = false;
    els.userAvatarFallback.textContent = initials;
  }
}

async function loadTimezone() {
  const data = await api("/api/user/timezone", { method: "GET" });
  renderTimezone(data.timezone);
}

async function saveTimezone() {
  const timezone = els.timezoneInput.value.trim();
  if (!timezone) {
    showToast("Введите часовой пояс", "error");
    return;
  }

  try {
    setBusy(true);
    const data = await api("/api/user/timezone", {
      method: "PUT",
      body: JSON.stringify({ timezone }),
    });
    renderTimezone(data.timezone);
    await loadTasks();
    showToast("Часовой пояс сохранен", "success");
  } catch (error) {
    handleError(error, "Ошибка сохранения часового пояса");
  } finally {
    setBusy(false);
  }
}

async function loadTasks() {
  const tasks = await api("/api/tasks", { method: "GET" });
  state.tasks = [...tasks].sort((a, b) => a.scheduled_utc.localeCompare(b.scheduled_utc));
  renderTasks();
}

async function submitTask() {
  if (isBusy()) {
    return;
  }

  const text = els.taskText.value.trim();
  const datetime = normalizeDatetimeValue(els.taskDatetime.value);

  if (!text) {
    showToast("Введите текст задачи", "error");
    return;
  }
  if (!datetime) {
    showToast("Укажите дату и время", "error");
    return;
  }

  const payload = {
    text,
    scheduled_local: localInputToApi(datetime),
  };

  try {
    setBusy(true);

    if (state.editingTaskId) {
      await api(`/api/tasks/${state.editingTaskId}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      showToast("Задача обновлена", "success");
    } else {
      await api("/api/tasks", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      showToast("Задача добавлена", "success");
    }

    resetForm();
    await loadTasks();
    switchTab("tasks");
  } catch (error) {
    handleError(error, "Ошибка сохранения задачи");
  } finally {
    setBusy(false);
  }
}

function measurePanelHeight(panel) {
  const hidden = panel.hidden;
  let height;

  if (hidden) {
    panel.hidden = false;
    panel.style.position = "absolute";
    panel.style.visibility = "hidden";
    panel.style.pointerEvents = "none";
    panel.style.inset = "0";
    panel.classList.add("active");
    height = panel.offsetHeight;
    panel.classList.remove("active");
    panel.style.position = "";
    panel.style.visibility = "";
    panel.style.pointerEvents = "";
    panel.style.inset = "";
    panel.hidden = true;
  } else {
    height = panel.offsetHeight;
  }

  return height || 0;
}

function syncViewportHeight() {
  const addHeight = measurePanelHeight(els.tabAdd);
  const tasksHeight = measurePanelHeight(els.tabTasks);
  const maxHeight = Math.max(addHeight, tasksHeight, 420);

  state.viewportMinHeight = Math.max(state.viewportMinHeight, maxHeight);
  els.tabsViewport.style.minHeight = `${state.viewportMinHeight}px`;
}

async function initialize() {
  tg.ready();
  tg.expand();

  renderUserInfo();

  tg.MainButton.onClick(submitTask);

  els.tabAddBtn.addEventListener("click", () => switchTab("add"));
  els.tabTasksBtn.addEventListener("click", () => switchTab("tasks"));
  els.saveTimezoneBtn.addEventListener("click", saveTimezone);
  els.refreshBtn.addEventListener("click", async () => {
    try {
      setBusy(true);
      await loadTasks();
      showToast("Список задач обновлен", "success");
    } catch (error) {
      handleError(error, "Ошибка обновления задач");
    } finally {
      setBusy(false);
    }
  });
  els.cancelEditBtn.addEventListener("click", resetForm);

  window.addEventListener("resize", syncViewportHeight);

  if (!state.initData) {
    showToast("Откройте приложение внутри Telegram", "error");
    updateMainButtonState();
    return;
  }

  try {
    setBusy(true);
    await Promise.all([loadTimezone(), loadTasks()]);
    switchTab("add");
  } catch (error) {
    handleError(error, "Ошибка загрузки данных");
  } finally {
    setBusy(false);
  }
}

initialize();
