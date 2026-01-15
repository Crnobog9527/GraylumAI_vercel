'use client';

import { trpc } from '@/trpc/client';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useState } from 'react';

interface AIModel {
  id: string;
  name: string;
  provider: string;
  endpoint: string;
  config: Record<string, unknown>;
}

export default function ModelsPage() {
  const { data: models, isLoading, error, refetch } = trpc.model.getAvailableModels.useQuery();
  const updateModelMutation = trpc.model.updateModelConfig.useMutation({
    onSuccess: () => {
      refetch();
      setEditingModelId(null);
      setNewConfig('');
    },
  });

  const [editingModelId, setEditingModelId] = useState<string | null>(null);
  const [newConfig, setNewConfig] = useState<string>('');

  const handleEdit = (modelId: string, currentConfig: Record<string, unknown>) => {
    setEditingModelId(modelId);
    setNewConfig(JSON.stringify(currentConfig, null, 2));
  };

  const handleSave = (modelId: string) => {
    try {
      const parsedConfig = JSON.parse(newConfig);
      updateModelMutation.mutate({ id: modelId, config: parsedConfig });
    } catch {
      alert('Invalid JSON config');
    }
  };

  if (isLoading) return <div className="container mx-auto p-4">Loading models...</div>;

  if (error) {
    return (
      <div className="container mx-auto p-4">
        <h1 className="text-2xl font-bold mb-4">AI Models Management</h1>
        <Card className="bg-red-50 border-red-200">
          <CardContent className="pt-6">
            <p className="text-red-600">
              {error.message === 'You do not have permission to access this resource. Admin role required.'
                ? 'Access Denied: You need admin privileges to view this page.'
                : `Error: ${error.message}`}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="container mx-auto p-4">
      <h1 className="text-2xl font-bold mb-4">AI Models Management</h1>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {models && models.length > 0 ? (
          models.map((model: AIModel) => (
            <Card key={model.id}>
              <CardHeader>
                <CardTitle>{model.name}</CardTitle>
              </CardHeader>
              <CardContent>
                <p>Provider: {model.provider}</p>
                <p>Endpoint: {model.endpoint}</p>
                <h3 className="font-semibold mt-2">Config:</h3>
                {editingModelId === model.id ? (
                  <>
                    <textarea
                      className="w-full h-32 p-2 border rounded-md mt-1 font-mono text-sm"
                      value={newConfig}
                      onChange={(e) => setNewConfig(e.target.value)}
                    />
                    <div className="flex gap-2 mt-2">
                      <Button onClick={() => handleSave(model.id)} disabled={updateModelMutation.isPending}>
                        {updateModelMutation.isPending ? 'Saving...' : 'Save'}
                      </Button>
                      <Button variant="outline" onClick={() => setEditingModelId(null)}>
                        Cancel
                      </Button>
                    </div>
                  </>
                ) : (
                  <>
                    <pre className="bg-gray-100 p-2 rounded-md text-sm overflow-auto mt-1">
                      {JSON.stringify(model.config, null, 2)}
                    </pre>
                    <Button className="mt-2" onClick={() => handleEdit(model.id, model.config)}>
                      Edit Config
                    </Button>
                  </>
                )}
              </CardContent>
            </Card>
          ))
        ) : (
          <p className="text-gray-500 col-span-full">No AI models configured yet.</p>
        )}
      </div>
    </div>
  );
}
