import { useState, useCallback } from 'react';

export interface Task {
  id: string;
  subject: string;
  status: 'pending' | 'in_progress' | 'completed';
  createdAt: number;
}

export function useTasks() {
  const [tasks, setTasks] = useState<Task[]>([]);

  const addTask = useCallback((data: { subject: string; status: Task['status'] }) => {
    const task: Task = {
      id: crypto.randomUUID(),
      subject: data.subject,
      status: data.status,
      createdAt: Date.now(),
    };
    setTasks((prev) => [...prev, task]);
  }, []);

  const updateTaskStatus = useCallback((id: string, status: Task['status']) => {
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, status } : t)));
  }, []);

  const removeTask = useCallback((id: string) => {
    setTasks((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const clearTasks = useCallback(() => {
    setTasks([]);
  }, []);

  return { tasks, addTask, updateTaskStatus, removeTask, clearTasks };
}
