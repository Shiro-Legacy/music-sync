import {
  completeHandler,
  createDownloadTask,
  getExistingDownloadTasks,
  setConfig,
} from '@kesha-antonov/react-native-background-downloader';

export interface DownloadRequest {
  /** Stable job id — we use the track id so tasks can be re-matched after relaunch. */
  id: string;
  url: string;
  destination: string;
  headers: Record<string, string>;
}

export interface DownloaderEvents {
  onDone: (id: string, location: string, bytesDownloaded: number) => void;
  onError: (id: string, error: string, errorCode: number) => void;
  onProgress?: (id: string, bytesDownloaded: number, bytesTotal: number) => void;
}

export interface Downloader {
  enqueue(req: DownloadRequest): void;
  /** Rebinds handlers to tasks that survived an app restart. Returns their ids. */
  reattach(): Promise<string[]>;
}

type Task = ReturnType<typeof createDownloadTask>;

let configured = false;

/**
 * Thin wrapper around @kesha-antonov/react-native-background-downloader
 * (createDownloadTask / getExistingDownloadTasks / completeHandler per its README).
 */
export function createDownloader(events: DownloaderEvents): Downloader {
  if (!configured) {
    configured = true;
    setConfig({
      isLogsEnabled: false,
      progressInterval: 1000,
      maxParallelDownloads: 4,
    });
  }

  const attach = (task: Task): void => {
    task
      .progress(({ bytesDownloaded, bytesTotal }) => {
        events.onProgress?.(task.id, bytesDownloaded, bytesTotal);
      })
      .done(({ location, bytesDownloaded }) => {
        try {
          events.onDone(task.id, location, bytesDownloaded);
        } finally {
          void completeHandler(task.id);
        }
      })
      .error(({ error, errorCode }) => {
        try {
          events.onError(task.id, error, errorCode);
        } finally {
          void completeHandler(task.id);
        }
      });
  };

  return {
    enqueue(req: DownloadRequest): void {
      const task = createDownloadTask({
        id: req.id,
        url: req.url,
        destination: req.destination,
        headers: req.headers,
      });
      attach(task);
      task.start();
    },

    async reattach(): Promise<string[]> {
      const tasks = await getExistingDownloadTasks();
      for (const task of tasks) {
        attach(task);
        if (task.state === 'PAUSED') {
          void task.resume();
        }
      }
      return tasks.map((t) => t.id);
    },
  };
}
