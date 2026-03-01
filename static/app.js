const tg = window.Telegram.WebApp;

const state = {
  tasks: [],
  editingTaskId: null,
  initData: tg.initData || "",
  activeTab: "add",
  timezone: "",
};

const els = {
  tabAddBtn: document.getElementById("tabAddBtn"),
  tabTasksBtn: document.getElementById("tabTasksBtn"),
  tabAdd: document.getElementById("tabAdd"),
  tabTasks: document.getElementById("tabTasks"),
  taskText: document.getElementById("taskText"),
  taskDatetime: document.getElementById("taskDatetime"),
  formTitle: document.getElementById("formTitle"),
  editActions: document.getElementById("editActions"),
  cancelEditBtn: document.getElementById("cancelEditBtn"),
  timezoneInput: document.getElementById("timezoneInput"),
  timezoneCurrent: document.getElementById("timezoneCurrent"),
  saveTimezoneBtn: document.getElementById("saveTimezoneBtn"),
  refreshBtn: document.getElementById("refreshBtn"),
  loading: document.getElementById("loading"),
  error: document.getElementById("error"),
  tasks: document.getElementById("tasks"),
  emptyState: document.getElementById("emptyState"),
  taskTemplate: document.getElementById("taskTemplate"),
};

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
}

function updateMainButtonState() {
  if (!state.initData) {
    tg.MainButton.hide();
    return;
  }

  if (state.activeTab !== "add") {
    tg.MainButton.hide();
    return;
  }

  tg.MainButton.show();
  if (state.editingTaskId) {
    tg.MainButton.setText("Сохранить изменения");
    tg.MainButton.color = "#1d95d5";
  } else {
    tg.MainButton.setText("Добавить задачу");
    tg.MainButton.color = "#2aabee";
  }
}

function showLoading(value) {
  els.loading.hidden = !value;
}

function showError(message) {
  if (!message) {
    els.error.hidden = true;
    els.error.textContent = "";
    return;
  }
  els.error.hidden = false;
  els.error.textContent = message;
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

function localInputToApi(value) {
  return value.replace("T", " ");
}

function apiToLocalInput(value) {
  return value.replace(" ", "T");
}

function resetForm() {
  state.editingTaskId = null;
  els.formTitle.textContent = "Новая задача";
  els.editActions.hidden = true;
  els.taskText.value = "";
  els.taskDatetime.value = "";
  updateMainButtonState();
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
        showError("");
        showLoading(true);
        await api(`/api/tasks/${task.id}`, { method: "DELETE" });
        await loadTasks();
        if (state.editingTaskId === task.id) {
          resetForm();
        }
      } catch (error) {
        showError(error.message);
      } finally {
        showLoading(false);
      }
    });

    els.tasks.appendChild(node);
  });
}

function renderTimezone(timezone) {
  state.timezone = timezone;
  els.timezoneInput.value = timezone;
  els.timezoneCurrent.textContent = `Текущий: ${timezone}`;
}

async function loadTimezone() {
  const data = await api("/api/user/timezone", { method: "GET" });
  renderTimezone(data.timezone);
}

async function saveTimezone() {
  const timezone = els.timezoneInput.value.trim();
  if (!timezone) {
    showError("Введите часовой пояс");
    return;
  }

  try {
    showError("");
    showLoading(true);
    const data = await api("/api/user/timezone", {
      method: "PUT",
      body: JSON.stringify({ timezone }),
    });
    renderTimezone(data.timezone);
    await loadTasks();
  } catch (error) {
    showError(error.message);
  } finally {
    showLoading(false);
  }
}

async function loadTasks() {
  const tasks = await api("/api/tasks", { method: "GET" });
  state.tasks = tasks;
  renderTasks();
}

async function submitTask() {
  const text = els.taskText.value.trim();
  const datetime = els.taskDatetime.value;

  if (!text) {
    showError("Введите текст задачи");
    return;
  }
  if (!datetime) {
    showError("Укажите дату и время");
    return;
  }

  const payload = {
    text,
    scheduled_local: localInputToApi(datetime),
  };

  try {
    showError("");
    showLoading(true);

    if (state.editingTaskId) {
      await api(`/api/tasks/${state.editingTaskId}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
    } else {
      await api("/api/tasks", {
        method: "POST",
        body: JSON.stringify(payload),
      });
    }

    resetForm();
    await loadTasks();
    switchTab("tasks");
  } catch (error) {
    showError(error.message);
  } finally {
    showLoading(false);
  }
}

async function initialize() {
  tg.ready();
  tg.expand();

  tg.MainButton.onClick(submitTask);

  els.tabAddBtn.addEventListener("click", () => switchTab("add"));
  els.tabTasksBtn.addEventListener("click", () => switchTab("tasks"));
  els.saveTimezoneBtn.addEventListener("click", saveTimezone);
  els.refreshBtn.addEventListener("click", async () => {
    try {
      showError("");
      showLoading(true);
      await loadTasks();
    } catch (error) {
      showError(error.message);
    } finally {
      showLoading(false);
    }
  });
  els.cancelEditBtn.addEventListener("click", resetForm);

  if (!state.initData) {
    showError("Откройте приложение внутри Telegram");
    updateMainButtonState();
    return;
  }

  try {
    showLoading(true);
    await Promise.all([loadTimezone(), loadTasks()]);
    switchTab("add");
  } catch (error) {
    showError(error.message);
  } finally {
    showLoading(false);
  }
}

initialize();
